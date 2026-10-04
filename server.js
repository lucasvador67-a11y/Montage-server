const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const DOWNLOAD_DIR = '/tmp/montage-downloads';
const FILE_TTL_MS = 2 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const jobs = new Map();

app.use(cors({
  origin: '*',
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${req.method} ${req.path}`);
  next();
});

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

function isYtDlpAvailable() {
  return new Promise(resolve => {
    const proc = spawn('yt-dlp', ['--version']);
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function isFfmpegAvailable() {
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanupOldFiles() {
  const now = Date.now();
  let cleaned = 0;
  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt && now - job.createdAt > FILE_TTL_MS) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        try { fs.unlinkSync(job.filePath); cleaned++; } catch {}
      }
      jobs.delete(jobId);
    }
  }
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    for (const f of files) {
      const fullPath = path.join(DOWNLOAD_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > FILE_TTL_MS) {
          fs.unlinkSync(fullPath);
          cleaned++;
        }
      } catch {}
    }
  } catch {}
  if (cleaned > 0) log(`Nettoyage : ${cleaned} fichier(s)`);
}

setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS);

app.get('/', (req, res) => {
  res.json({
    service: 'Montage Studio Backend',
    status: 'ok',
    version: '1.0.0',
    uptime: Math.round(process.uptime()) + 's',
    jobs: jobs.size,
  });
});

app.get('/api/health', async (req, res) => {
  const [ytDlp, ffmpeg] = await Promise.all([isYtDlpAvailable(), isFfmpegAvailable()]);
  res.json({
    ok: ytDlp,
    ytdlp: ytDlp,
    ffmpeg: ffmpeg,
    version: process.version,
    platform: process.platform,
  });
});

app.post('/api/download', async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ error: 'URL invalide' });
  }

  if (!(await isYtDlpAvailable())) {
    return res.status(500).json({
      error: 'yt-dlp non installé sur le serveur',
    });
  }

  const jobId = uuidv4();
  const job = {
    id: jobId,
    url,
    status: 'starting',
    progress: 0,
    stage: 'Démarrage…',
    createdAt: Date.now(),
    filePath: null,
    filename: null,
    filesize: 0,
    duration: 0,
    title: '',
    error: null,
    process: null,
  };
  jobs.set(jobId, job);

  log(`Nouveau job ${jobId.slice(0, 8)} : ${url.slice(0, 80)}`);

  res.json({ jobId, status: 'starting' });

  startDownload(job);
});

async function startDownload(job) {
  const outputTemplate = path.join(DOWNLOAD_DIR, job.id + '.%(ext)s');

  const args = [
    job.url,
    '-f', 'bv*[vcodec~="^(avc|h264)"][ext=mp4]+ba[acodec~="^(mp4a|aac)"][ext=m4a]/bv*[vcodec~="^(avc|h264)"]/b[vcodec~="^(avc|h264)"]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--postprocessor-args', 'Merger+ffmpeg:-movflags +faststart',
    '-o', outputTemplate,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '--print', 'after_move:FILE:%(filepath)s',
    '--print', 'video:TITLE:%(title)s',
    '--print', 'video:DURATION:%(duration)s',
    '--print', 'video:FILESIZE:%(filesize)s',
  ];

  if (process.env.YTDLP_COOKIES) {
    const cookiesPath = path.join(DOWNLOAD_DIR, 'cookies.txt');
    try {
      const raw = process.env.YTDLP_COOKIES;
      if (raw.startsWith('base64:')) {
        fs.writeFileSync(cookiesPath, Buffer.from(raw.slice(7), 'base64').toString('utf8'));
      } else {
        fs.writeFileSync(cookiesPath, raw);
      }
      args.push('--cookies', cookiesPath);
    } catch (e) {
      log(`Cookies ignorés : ${e.message}`);
    }
  }

  log(`Job ${job.id.slice(0, 8)} : lancement yt-dlp…`);
  job.status = 'downloading';
  job.stage = 'Téléchargement…';

  const proc = spawn('yt-dlp', args);
  job.process = proc;

  let output = '';
  let errorOutput = '';

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;

    text.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;

      const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
      if (progressMatch) {
        job.progress = parseFloat(progressMatch[1]);
        job.stage = `Téléchargement… ${job.progress.toFixed(1)}%`;
        return;
      }

      if (line.includes('[Merger]')) {
        job.stage = 'Fusion audio/vidéo…';
        job.progress = 90;
        return;
      }

      if (line.includes('[ExtractAudio]')) {
        job.stage = 'Extraction audio…';
        return;
      }

      const titleMatch = line.match(/^TITLE:(.+)$/);
      if (titleMatch) {
        job.title = titleMatch[1].trim();
        return;
      }

      const durationMatch = line.match(/^DURATION:([\d.]+)$/);
      if (durationMatch) {
        job.duration = parseFloat(durationMatch[1]);
        return;
      }

      const sizeMatch = line.match(/^FILESIZE:(\d+)$/);
      if (sizeMatch) {
        job.filesize = parseInt(sizeMatch[1], 10);
        return;
      }

      const fileMatch = line.match(/^FILE:(.+)$/);
      if (fileMatch) {
        job.filePath = fileMatch[1].trim();
        job.filename = path.basename(job.filePath);
        return;
      }
    });
  });

  proc.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });

  proc.on('error', (err) => {
    job.status = 'error';
    job.error = 'Erreur spawn yt-dlp : ' + err.message;
    log(`Job ${job.id.slice(0, 8)} ERREUR : ${err.message}`);
  });

  proc.on('close', (code) => {
    if (code === 0 && job.filePath && fs.existsSync(job.filePath)) {
      try {
        const stat = fs.statSync(job.filePath);
        job.filesize = stat.size;
        job.status = 'ready';
        job.stage = 'Prêt';
        job.progress = 100;
        log(`Job ${job.id.slice(0, 8)} PRÊT : ${path.basename(job.filePath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      } catch (e) {
        job.status = 'error';
        job.error = 'Fichier introuvable après téléchargement';
      }
    } else if (job.status !== 'error') {
      job.status = 'error';
      const lines = errorOutput.split('\n').filter(l => l.includes('ERROR') || l.includes('error'));
      job.error = lines.length > 0
        ? lines[lines.length - 1].replace(/^ERROR:\s*/, '').slice(0, 300)
        : 'Échec du téléchargement (code ' + code + ')';
      log(`Job ${job.id.slice(0, 8)} ÉCHEC : ${job.error}`);
    }
  });
}

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job introuvable' });
  }
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    title: job.title,
    duration: job.duration,
    filesize: job.filesize,
    error: job.error,
    fileUrl: job.status === 'ready' ? `/api/file/${job.id}` : null,
  });
});

app.get('/api/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  if (job.status !== 'ready') return res.status(425).json({ error: 'Fichier pas encore prêt' });
  if (!job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(410).json({ error: 'Fichier supprimé' });
  }

  const stat = fs.statSync(job.filePath);
  const total = stat.size;
  const range = req.headers.range;

  const ext = path.extname(job.filePath).toLowerCase();
  const mimeMap = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.m4v': 'video/mp4',
    '.avi': 'video/x-msvideo',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10) || 0;
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunkSize = end - start + 1;

    if (start >= total || end >= total || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': chunkSize,
      'Accept-Ranges': 'bytes',
    });

    fs.createReadStream(job.filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(job.filePath).pipe(res);
  }
});

app.delete('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  if (job.process) { try { job.process.kill(); } catch {} }
  if (job.filePath && fs.existsSync(job.filePath)) {
    try { fs.unlinkSync(job.filePath); } catch {}
  }
  jobs.delete(req.params.jobId);
  res.json({ ok: true });
});

app.get('/api/jobs', (req, res) => {
  const list = Array.from(jobs.values()).map(j => ({
    id: j.id,
    url: j.url.slice(0, 80),
    status: j.status,
    progress: j.progress,
    title: j.title,
    createdAt: j.createdAt,
  }));
  res.json({ count: list.length, jobs: list });
});

app.listen(PORT, async () => {
  log(`═══════════════════════════════════════════════════`);
  log(`Montage Studio Backend démarré`);
  log(`Port : ${PORT}`);
  log(`Dossier : ${DOWNLOAD_DIR}`);
  const yt = await isYtDlpAvailable();
  const ff = await isFfmpegAvailable();
  log(`yt-dlp : ${yt ? '✅ disponible' : '❌ MANQUANT'}`);
  log(`ffmpeg : ${ff ? '✅ disponible' : '❌ MANQUANT'}`);
  log(`═══════════════════════════════════════════════════`);
});
