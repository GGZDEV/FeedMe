'use strict';

/* ════════════════════════════════════════
   winmetrics — mesures Windows que systeminformation n'expose pas
   ──────────────────────────────────────────
   Trois trous à combler sur ce système :

   1. GPU. `si.graphics()` ne remonte charge / VRAM utilisée / température que
      pour les cartes NVIDIA (il appelle nvidia-smi). Sur AMD et Intel, il ne
      reste que le modèle et la VRAM totale.
   2. Débit disque. `si.disksIO()` et `si.fsStats()` renvoient `null` sous
      Windows — non implémentés.
   3. Températures. Aucun capteur n'est exposé sans pilote dédié.

   Les compteurs de performance Windows couvrent 1 et 2. On les lit via WMI
   (classes `Win32_PerfFormattedData_*`) et non via typeperf/PDH, parce que les
   noms de compteurs PDH sont traduits — sur un Windows fr-FR,
   « \PhysicalDisk(_Total)\Disk Read Bytes/sec » n'existe pas. Les noms de
   classes et de propriétés WMI, eux, sont invariants.

   Coût mesuré : ~590 ms d'horloge mais seulement ~41 ms de CPU par échantillon
   (le reste est de l'attente sur le rafraîchissement du fournisseur). D'où le
   choix d'un processus PowerShell unique et persistant qui boucle et publie une
   ligne JSON par échantillon : on paie le démarrage (~700 ms) une seule fois.
   Le processus ne démarre qu'à la première demande et s'arrête de lui-même
   quand plus personne ne lit — un dashboard sans widget système ne coûte rien.

   Le point 3 nécessite un pilote noyau. LibreHardwareMonitor en fournit un et
   publie ses capteurs en JSON sur http://localhost:8085 quand son serveur web
   est activé : on s'y branche s'il est là, sinon les températures restent nulles.
   ════════════════════════════════════════ */

const { spawn } = require('child_process');

const SAMPLE_MS = 1500;   // cadence d'échantillonnage du helper
const IDLE_MS = 20000;    // sans lecture pendant ce délai, le helper s'arrête
const LHM_URL = 'http://localhost:8085/data.json';
const LHM_RETRY_MS = 30000;

/* ────────────────────────────────────────
   Le script PowerShell persistant
   ──────────────────────────────────────── */
// Le PID parent est injecté : sous Windows un enfant survit à la mort de son
// parent, et un arrêt brutal du serveur (kill sans signal) ne laisse passer
// aucun handler côté Node. Sans ce garde-fou, chaque crash laisse un
// PowerShell qui boucle indéfiniment — constaté en test.
const psScript = (parentPid) => `
$ErrorActionPreference = 'SilentlyContinue'
$epoch = [datetime]'1970-01-01T00:00:00Z'
$parent = ${parentPid}
$tick = 0
$disks = @()
while ($true) {
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
  $disk = Get-CimInstance -Query "SELECT DiskReadBytesPerSec,DiskWriteBytesPerSec,CurrentDiskQueueLength FROM Win32_PerfFormattedData_PerfDisk_PhysicalDisk WHERE Name='_Total'"
  $mem  = Get-CimInstance -Query "SELECT Name,DedicatedUsage,SharedUsage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory" |
          Sort-Object DedicatedUsage -Descending | Select-Object -First 1
  $eng  = Get-CimInstance -Query "SELECT Name,UtilizationPercentage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine WHERE UtilizationPercentage > 0"
  $net  = Get-CimInstance -Query "SELECT Name,BytesReceivedPersec,BytesSentPersec FROM Win32_PerfFormattedData_Tcpip_NetworkInterface" |
          Sort-Object { $_.BytesReceivedPersec + $_.BytesSentPersec } -Descending | Select-Object -First 1

  # L'occupation des disques bouge lentement : une fois sur vingt suffit.
  if ($tick % 20 -eq 0) {
    $disks = @(Get-CimInstance -Query "SELECT DeviceID,Size,FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3" |
      Where-Object { $_.Size -gt 0 } |
      ForEach-Object { [ordered]@{ name = $_.DeviceID; total = [int64]$_.Size; free = [int64]$_.FreeSpace } })
  }
  $tick++

  # Les moteurs GPU sont listés par processus ET par adaptateur. On ne somme que
  # ceux de l'adaptateur qui consomme le plus de VRAM : c'est la vraie carte,
  # pas un écran virtuel (Parsec, RDP…) qui traînerait dans la liste.
  $luid = if ($mem) { $mem.Name } else { $null }
  $g3d = 0.0; $gcopy = 0.0; $gvideo = 0.0
  foreach ($e in $eng) {
    if ($luid -and -not $e.Name.Contains($luid)) { continue }
    if     ($e.Name -like '*engtype_3D*')    { $g3d    += $e.UtilizationPercentage }
    elseif ($e.Name -like '*engtype_Copy*')  { $gcopy  += $e.UtilizationPercentage }
    elseif ($e.Name -like '*engtype_Video*') { $gvideo += $e.UtilizationPercentage }
  }

  $out = [ordered]@{
    t     = [int64]((Get-Date).ToUniversalTime() - $epoch).TotalMilliseconds
    dr    = [int64]$disk.DiskReadBytesPerSec
    dw    = [int64]$disk.DiskWriteBytesPerSec
    dq    = [int]$disk.CurrentDiskQueueLength
    g3d   = [math]::Round([math]::Min($g3d, 100), 1)
    gcopy = [math]::Round([math]::Min($gcopy, 100), 1)
    gvid  = [math]::Round([math]::Min($gvideo, 100), 1)
    vram  = [int64]$mem.DedicatedUsage
    vshar = [int64]$mem.SharedUsage
    nif   = [string]$net.Name
    nrx   = [int64]$net.BytesReceivedPersec
    ntx   = [int64]$net.BytesSentPersec
    disks = $disks
  }
  Write-Output ($out | ConvertTo-Json -Compress -Depth 4)
  Start-Sleep -Milliseconds ${SAMPLE_MS}
}
`;

let child = null;
let latest = null;
let lastReadAt = 0;
let idleTimer = null;
let spawnFailed = false;

function startHelper() {
  if (child || spawnFailed) return;

  // -EncodedCommand évite tout échappement de guillemets dans les requêtes WQL.
  const encoded = Buffer.from(psScript(process.pid), 'utf16le').toString('base64');
  try {
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    spawnFailed = true;
    return;
  }

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    // Une ligne = un échantillon. On garde le reliquat partiel pour la suite.
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { latest = JSON.parse(line); } catch (e) { /* ligne tronquée : ignorée */ }
    }
  });

  child.on('error', () => { spawnFailed = true; stopHelper(); });
  child.on('exit', () => { child = null; latest = null; });

  idleTimer = setInterval(() => {
    if (Date.now() - lastReadAt > IDLE_MS) stopHelper();
  }, 5000);
}

function stopHelper() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  if (child) {
    const dying = child;
    child = null;
    latest = null;
    // Les enfants ne meurent pas avec le parent sous Windows : kill explicite.
    try { dying.kill(); } catch (e) { /* déjà mort */ }
  }
}

for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, stopHelper);
}

/* ────────────────────────────────────────
   LibreHardwareMonitor (températures)
   ──────────────────────────────────────── */
let lhmAvailable = null;   // null = pas encore testé
let lhmNextTry = 0;
let lhmCache = { at: 0, data: null };

// Les valeurs LHM sont des chaînes localisées : « 52,0 °C », « 1 234 MB ».
function parseLhmValue(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function walkLhm(node, path, out) {
  const label = node.Text || '';
  const here = label ? [...path, label] : path;
  if (node.Value !== undefined && node.Value !== null && node.Value !== '') {
    out.push({ path: here, value: parseLhmValue(node.Value), raw: node.Value });
  }
  for (const child of node.Children || []) walkLhm(child, here, out);
}

async function readLhm() {
  if (Date.now() - lhmCache.at < 1200) return lhmCache.data;
  if (lhmAvailable === false && Date.now() < lhmNextTry) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const res = await fetch(LHM_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`LHM ${res.status}`);

    const sensors = [];
    walkLhm(await res.json(), [], sensors);

    const pick = (predicate) => sensors.find(predicate)?.value ?? null;
    const isTemp = (s) => s.path.includes('Temperatures');
    const joined = (s) => s.path.join(' / ').toLowerCase();

    const data = {
      available: true,
      cpuC: pick((s) => isTemp(s) && /tctl|tdie|package|cpu core$/i.test(s.path.at(-1)))
        ?? pick((s) => isTemp(s) && /cpu/.test(joined(s))),
      gpuC: pick((s) => isTemp(s) && /gpu core/i.test(s.path.at(-1)))
        ?? pick((s) => isTemp(s) && /gpu/.test(joined(s))),
      gpuHotspotC: pick((s) => isTemp(s) && /hot ?spot|junction/i.test(s.path.at(-1))),
      cpuFanRpm: pick((s) => s.path.includes('Fans') && /cpu/.test(joined(s))),
      gpuFanRpm: pick((s) => s.path.includes('Fans') && /gpu/.test(joined(s))),
      gpuPowerW: pick((s) => s.path.includes('Powers') && /gpu package|gpu total/i.test(s.path.at(-1))),
    };
    lhmAvailable = true;
    lhmCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    lhmAvailable = false;
    lhmNextTry = Date.now() + LHM_RETRY_MS;
    lhmCache = { at: Date.now(), data: null };
    return null;
  }
}

/* ────────────────────────────────────────
   API
   ──────────────────────────────────────── */
module.exports = {
  // Marque une demande : démarre le helper au besoin et rend le dernier
  // échantillon (null pendant le ~1er démarrage, le client s'en accommode).
  sample() {
    if (process.platform !== 'win32') return null;
    lastReadAt = Date.now();
    startHelper();
    return latest;
  },
  readLhm,
  get lhmAvailable() { return lhmAvailable; },
  get counterAvailable() { return !spawnFailed && latest !== null; },
  stop: stopHelper,
};
