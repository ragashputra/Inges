/* =========================================================================
   INGES — Input Gesek
   Logic: Google OAuth (GIS) + Sheets API v4 + CSV parsing + UI orchestration
   ========================================================================= */

/* ---------------- CONFIG ---------------- */
// TODO ganti dengan OAuth Client ID milikmu dari Google Cloud Console
const GOOGLE_CLIENT_ID = '622950826437-nqrvo65q8csnjdvbmmd74jjng6uitbej.apps.googleusercontent.com';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';

const STORAGE_KEYS = {
  sheetId: 'inges_sheet_id',
  token: 'inges_gtoken',
  tokenExp: 'inges_gtoken_exp',
};

// Nama bulan Indonesia -> dipakai untuk menentukan nama sheet aktif otomatis
const BULAN_ID = ['JAN','FEB','MAR','APR','MEI','JUN','JUL','AGTS','SEPT','OKT','NOV','DES'];
const BULAN_ID_LONG = ['JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI','JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER'];

/* ---------------- STATE ---------------- */
const state = {
  accessToken: null,
  tokenClient: null,
  userEmail: null,
  userPicture: null,
  spreadsheetId: null,
  activeSheetName: null,
  activeSheetHeaderRow: 6,   // baris header "Tanggal | Nomor Faktur..." (1-indexed)
  saldoAwal: 0,
  lastSaldoRow: null,        // row index terakhir berisi data (sebelum "Saldo Akhir")
  saldoAkhirRow: null,
  parsedDays: [],            // hasil parse csv -> [{date, fakturs:[], count, debit}]
  activeTab: 'import',
  sessionLog: [],
};

/* ---------------- DOM SHORTCUTS ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* =========================================================================
   TOAST
   ========================================================================= */
function toast(message, type = 'success', duration = 3400) {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success'
    ? '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  el.innerHTML = `${icon}<span>${message}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, duration);
}

/* =========================================================================
   GOOGLE OAUTH (GIS token client)
   ========================================================================= */
function initGoogleAuth() {
  if (!window.google || !google.accounts) {
    // GIS script belum siap, coba lagi sebentar
    setTimeout(initGoogleAuth, 200);
    return;
  }
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SHEETS_SCOPE,
    callback: onTokenReceived,
    error_callback: (err) => {
      console.error('OAuth error', err);
      toast('Gagal masuk. Coba lagi.', 'error');
    }
  });

  // cek token tersimpan (belum expired)
  const savedToken = localStorage.getItem(STORAGE_KEYS.token);
  const savedExp = parseInt(localStorage.getItem(STORAGE_KEYS.tokenExp) || '0', 10);
  if (savedToken && Date.now() < savedExp) {
    state.accessToken = savedToken;
    afterSignIn();
  }
}

function onTokenReceived(resp) {
  if (resp.error) {
    toast('Otorisasi ditolak.', 'error');
    return;
  }
  state.accessToken = resp.access_token;
  const expiresInMs = (resp.expires_in || 3500) * 1000;
  localStorage.setItem(STORAGE_KEYS.token, resp.access_token);
  localStorage.setItem(STORAGE_KEYS.tokenExp, String(Date.now() + expiresInMs - 60000));
  afterSignIn();
}

function requestSignIn() {
  if (!state.tokenClient) {
    toast('Google belum siap, coba lagi sebentar.', 'error');
    initGoogleAuth();
    return;
  }
  state.tokenClient.requestAccessToken({ prompt: '' });
}

async function afterSignIn() {
  $('#gate').classList.add('hidden');
  $('#mainContent').classList.remove('hidden');
  $('#bottomnav').classList.remove('hidden');

  try {
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${state.accessToken}` }
    });
    if (infoRes.ok) {
      const info = await infoRes.json();
      state.userEmail = info.email;
      state.userPicture = info.picture;
      renderAcctChip();
    }
  } catch (e) { /* non-fatal */ }

  const savedSheetId = localStorage.getItem(STORAGE_KEYS.sheetId);
  if (savedSheetId) {
    state.spreadsheetId = savedSheetId;
    await loadActiveSheetContext();
  } else {
    openModal('#setupModal');
  }
}

function renderAcctChip() {
  const area = $('#acctArea');
  area.innerHTML = `
    <button class="acct-chip" id="acctChipBtn">
      ${state.userPicture ? `<img src="${state.userPicture}" alt="">` : '<span class="acct-dot"></span>'}
      <span>${(state.userEmail || 'Akun').split('@')[0]}</span>
    </button>`;
  $('#acctChipBtn').addEventListener('click', openAcctModal);
}

function openAcctModal() {
  $('#acctModalEmail').textContent = state.userEmail || 'Akun Google';
  $('#acctModalSheet').textContent = state.activeSheetName
    ? `Terhubung ke sheet ${state.activeSheetName}`
    : 'Spreadsheet belum terhubung';

  const pic = $('#acctModalPic');
  const dot = $('#acctModalDot');
  if (state.userPicture) {
    pic.src = state.userPicture;
    pic.classList.remove('hidden');
    dot.classList.add('hidden');
  } else {
    pic.classList.add('hidden');
    dot.classList.remove('hidden');
  }
  openModal('#acctModal');
}

function setupAcctModal() {
  $('#acctModal').addEventListener('click', (e) => { if (e.target.id === 'acctModal') closeModal('#acctModal'); });

  $('#btnChangeSheet').addEventListener('click', () => {
    closeModal('#acctModal');
    openModal('#setupModal');
  });

  $('#btnLogout').addEventListener('click', doLogout);
}

function doLogout() {
  closeModal('#acctModal');
  const token = state.accessToken;

  const finishLogout = () => {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.tokenExp);
    state.accessToken = null;
    state.userEmail = null;
    state.userPicture = null;
    state.activeSheetName = null;

    $('#acctArea').innerHTML = '';
    $('#mainContent').classList.add('hidden');
    $('#bottomnav').classList.add('hidden');
    $('#gate').classList.remove('hidden');
    toast('Berhasil logout.', 'success');
  };

  if (token && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(token, finishLogout);
  } else {
    finishLogout();
  }
}

/* =========================================================================
   SHEETS API HELPERS
   ========================================================================= */
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsFetch(path, options = {}) {
  const res = await fetch(`${SHEETS_BASE}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    // token expired mid-session -> minta ulang
    localStorage.removeItem(STORAGE_KEYS.token);
    toast('Sesi berakhir, silakan masuk ulang.', 'error');
    requestSignIn();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Sheets API error ${res.status}`);
  }
  return res.json();
}

function currentMonthSheetName(date = new Date()) {
  const m = date.getMonth();
  const y = date.getFullYear();
  const yy = String(y).slice(-2);
  // Pola nama sheet historis bervariasi ("JUN 25", "APRIL 26", "MEI 2026", "JULI 2026")
  // Default: pakai nama bulan panjang + tahun 4 digit, sesuai 2 sheet terbaru di file acuan.
  return `${BULAN_ID_LONG[m]} ${y}`;
}

async function getSpreadsheetMeta() {
  return sheetsFetch(`${state.spreadsheetId}?fields=sheets.properties`);
}

async function findActiveSheet() {
  const meta = await getSpreadsheetMeta();
  const sheetNames = meta.sheets.map(s => s.properties.title);
  const now = new Date();
  const preferred = currentMonthSheetName(now);

  if (sheetNames.includes(preferred)) return preferred;

  // fallback: cocokkan berdasarkan bulan+tahun dengan variasi penulisan yang longgar
  const shortM = BULAN_ID[now.getMonth()];
  const yy = String(now.getFullYear()).slice(-2);
  const yyyy = String(now.getFullYear());
  const candidates = sheetNames.filter(n => {
    const up = n.toUpperCase();
    return (up.includes(shortM) || up.includes(BULAN_ID_LONG[now.getMonth()])) && (up.includes(yy) || up.includes(yyyy));
  });
  if (candidates.length) return candidates[candidates.length - 1];

  // fallback terakhir: sheet paling terakhir di daftar (biasanya bulan terbaru)
  return sheetNames[sheetNames.length - 1];
}

/**
 * Baca struktur sheet aktif: cari baris header, baris "Saldo Akhir",
 * baris data terakhir, dan nilai saldo saat ini.
 */
async function loadActiveSheetContext() {
  try {
    state.activeSheetName = await findActiveSheet();
    $('#monthPill').textContent = state.activeSheetName;

    const range = `'${state.activeSheetName}'!A1:F200`;
    const data = await sheetsFetch(`${state.spreadsheetId}/values/${encodeURIComponent(range)}`);
    const rows = data.values || [];

    let headerRow = -1;
    let saldoAkhirRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r[1] === 'Tanggal' && r[2] === 'Nomor Faktur Penjualan') headerRow = i;
      if (r && r[1] === 'Saldo Akhir') { saldoAkhirRow = i; break; }
    }
    if (headerRow === -1) throw new Error('Header kolom tidak ditemukan di sheet.');

    state.activeSheetHeaderRow = headerRow + 1; // 1-indexed
    // baris saldo awal = header+1 (kolom F biasanya sudah terisi saldo carry-over)
    const saldoAwalRow = rows[headerRow + 1] || [];
    state.saldoAwal = parseFloat(saldoAwalRow[5]) || 0;

    // cari baris data terakhir yang terisi (antara header+2 s/d sebelum Saldo Akhir)
    let lastFilled = headerRow + 1; // minimal saldo-awal row
    if (saldoAkhirRow > -1) {
      for (let i = headerRow + 2; i < saldoAkhirRow; i++) {
        const r = rows[i];
        if (r && (r[1] || r[2] || r[3] || r[4])) lastFilled = i;
      }
      state.saldoAkhirRow = saldoAkhirRow + 1; // 1-indexed
    } else {
      for (let i = headerRow + 2; i < rows.length; i++) {
        const r = rows[i];
        if (r && (r[1] || r[2] || r[3] || r[4])) lastFilled = i;
      }
      state.saldoAkhirRow = null;
    }
    state.lastSaldoRow = lastFilled + 1; // 1-indexed baris terakhir berisi data/saldo-awal

    // hitung current saldo dari kolom F baris terakhir yg terisi, kalau kosong pakai saldoAwal
    const lastRowVals = rows[lastFilled] || [];
    const currentSaldo = lastRowVals[5] !== undefined && lastRowVals[5] !== '' ? parseFloat(lastRowVals[5]) : state.saldoAwal;

    // hitung total credit/debit bulan ini (jumlahkan kolom D & E dari header+2 s/d lastFilled)
    let totalCredit = 0, totalDebit = 0;
    for (let i = headerRow + 2; i <= lastFilled; i++) {
      const r = rows[i];
      if (!r) continue;
      totalCredit += parseFloat(r[3]) || 0;
      totalDebit += parseFloat(r[4]) || 0;
    }

    updateSummary(currentSaldo, totalCredit, totalDebit);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Gagal membaca spreadsheet.', 'error');
  }
}

function updateSummary(saldo, credit, debit) {
  const num = $('#saldoNum');
  num.textContent = formatNum(saldo);
  num.classList.toggle('neg', saldo < 0);
  $('#statCredit').textContent = formatNum(credit);
  $('#statDebit').textContent = formatNum(debit);
}

function formatNum(n) {
  return new Intl.NumberFormat('id-ID').format(Math.round(n));
}

/* =========================================================================
   CSV PARSING
   Struktur (tanpa header, delimiter ';'):
   kolom0 = Nomor Faktur Penjualan (format NNNN/PGR/BULAN-ROMAWI/TAHUN)
   kolom1 = Tanggal transaksi (DD-MM-YYYY)
   Setiap 1 faktur = 2 pcs cek fisik terpakai (sepasang)
   ========================================================================= */
function parseCSV(text) {
  // strip BOM jika ada
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);

  const rows = lines.map(line => splitCSVLine(line, ';'));
  const validRows = rows.filter(r => r[0] && r[0].trim() && r[1] && r[1].trim());

  if (!validRows.length) throw new Error('File CSV kosong atau format tidak dikenali.');

  // group by tanggal (kolom index 1), pertahankan urutan tanggal pertama muncul
  const byDate = new Map();
  for (const r of validRows) {
    const faktur = r[0].trim();
    const tanggalRaw = r[1].trim();
    if (!byDate.has(tanggalRaw)) byDate.set(tanggalRaw, []);
    byDate.get(tanggalRaw).push(faktur);
  }

  const days = [];
  for (const [tanggalRaw, fakturs] of byDate.entries()) {
    const dateObj = parseDDMMYYYY(tanggalRaw);
    const sorted = fakturs.slice().sort((a, b) => extractFakturNum(a) - extractFakturNum(b));
    days.push({
      tanggalRaw,
      dateObj,
      fakturs: sorted,
      count: sorted.length,
      debit: sorted.length * 2,
      fakturRange: buildFakturRange(sorted),
    });
  }

  // urutkan berdasarkan tanggal asli
  days.sort((a, b) => (a.dateObj?.getTime() || 0) - (b.dateObj?.getTime() || 0));
  return days;
}

// parser CSV sederhana yang tetap menghormati kutip ganda jika ada
function splitCSVLine(line, delim) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseDDMMYYYY(str) {
  const m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return new Date(parseInt(y), parseInt(mo) - 1, parseInt(d));
}

function extractFakturNum(faktur) {
  const m = faktur.match(/^(\d+)\//);
  return m ? parseInt(m[1], 10) : 0;
}

function buildFakturRange(sortedFakturs) {
  if (!sortedFakturs.length) return '';
  if (sortedFakturs.length === 1) return sortedFakturs[0];
  const first = sortedFakturs[0];
  const last = sortedFakturs[sortedFakturs.length - 1];
  const firstNum = extractFakturNum(first);
  const lastNum = extractFakturNum(last);
  // ambil suffix (bagian setelah nomor pertama) dari faktur terakhir sebagai referensi format
  const suffixMatch = last.match(/^\d+(\/.*)$/);
  const suffix = suffixMatch ? suffixMatch[1] : '';
  const firstNumStr = String(firstNum).padStart(String(lastNum).length >= String(firstNum).length ? Math.min(4, String(firstNum).length) : String(firstNum).length, '0');
  return `${firstNum}-${lastNum}${suffix}`;
}

function formatTanggalDisplay(dateObj) {
  if (!dateObj) return { d: '--', mo: '---' };
  const bulanShort = ['JAN','FEB','MAR','APR','MEI','JUN','JUL','AGU','SEP','OKT','NOV','DES'];
  return { d: String(dateObj.getDate()).padStart(2, '0'), mo: bulanShort[dateObj.getMonth()] };
}

function formatTanggalForSheet(dateObj) {
  // mengikuti format existing: DD/MM/YYYY (untuk ditulis sebagai string tanggal)
  if (!dateObj) return '';
  const d = String(dateObj.getDate()).padStart(2, '0');
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const y = dateObj.getFullYear();
  return `${d}/${m}/${y}`;
}

/* =========================================================================
   UI: FILE HANDLING
   ========================================================================= */
function setupDropzone() {
  const dz = $('#dropzone');
  const input = $('#fileInput');

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  ['dragover', 'dragenter'].forEach(evt => {
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove('drag'); });
  });
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
    toast('Format file harus .csv', 'error');
    return;
  }

  $('#dropzone').classList.add('has-file');
  $('#dzTitle').textContent = 'File diterima';
  $('#dzSub').textContent = 'Membaca isi file…';
  $('#dzFilename').textContent = file.name;
  $('#dzFilename').classList.remove('hidden');

  const strip = $('#swipeStrip');
  strip.classList.remove('hidden');
  strip.classList.add('scanning');
  $('#swipeFill').style.width = '18%';

  const reader = new FileReader();
  reader.onload = (e) => {
    setTimeout(() => processCSVText(e.target.result, file.name), 350); // beri jeda utk animasi scan terasa
  };
  reader.onerror = () => {
    toast('Gagal membaca file.', 'error');
    strip.classList.remove('scanning');
  };
  reader.readAsText(file, 'utf-8');
}

function processCSVText(text, filename) {
  const strip = $('#swipeStrip');
  try {
    $('#swipeFill').style.width = '55%';
    const days = parseCSV(text);
    state.parsedDays = days;

    setTimeout(() => {
      $('#swipeFill').style.width = '100%';
      strip.classList.remove('scanning');
      $('#dzTitle').textContent = 'Berhasil dibaca';
      $('#dzSub').textContent = `${days.length} hari terdeteksi · ${days.reduce((s, d) => s + d.count, 0)} faktur`;
      renderPreview(days);
      $('#btnUpload').disabled = false;
      $('#btnUpload').classList.remove('hidden');
      toast(`Berhasil membaca ${filename}`, 'success');
    }, 380);
  } catch (err) {
    strip.classList.remove('scanning');
    $('#swipeFill').style.width = '0%';
    $('#dzTitle').textContent = 'Gagal memproses file';
    $('#dzSub').textContent = err.message;
    toast(err.message, 'error');
  }
}

function renderPreview(days) {
  const card = $('#previewCard');
  const list = $('#previewList');
  card.classList.remove('hidden');
  list.innerHTML = '';

  const totalUnits = days.reduce((s, d) => s + d.count, 0);
  const totalDebit = days.reduce((s, d) => s + d.debit, 0);
  $('#previewCount').textContent = `${totalUnits} unit · ${totalDebit} pcs`;

  days.forEach((day, idx) => {
    const { d, mo } = formatTanggalDisplay(day.dateObj);
    const row = document.createElement('div');
    row.className = 'day-row';
    row.style.animationDelay = `${idx * 35}ms`;
    row.innerHTML = `
      <div class="day-date"><b>${d}</b><span>${mo}</span></div>
      <div class="day-info">
        <div class="faktur-range">${day.fakturRange}</div>
        <div class="unit-count">${day.count} unit terjual</div>
      </div>
      <div class="day-debit">-${day.debit}<small>pcs</small></div>
    `;
    list.appendChild(row);
  });
}

/* =========================================================================
   WRITE TO SHEETS — IMPORT (per-hari)
   ========================================================================= */
async function confirmAndUploadImport() {
  if (!state.parsedDays.length) return;
  if (!state.spreadsheetId || !state.activeSheetName) {
    toast('Spreadsheet belum terhubung.', 'error');
    return;
  }

  const totalDebit = state.parsedDays.reduce((s, d) => s + d.debit, 0);
  const totalUnits = state.parsedDays.reduce((s, d) => s + d.count, 0);

  $('#confirmSheetName').textContent = state.activeSheetName;
  $('#confirmTable').innerHTML = `
    <div class="confirm-row"><span>Jumlah hari</span><span>${state.parsedDays.length}</span></div>
    <div class="confirm-row"><span>Total unit terjual</span><span>${totalUnits}</span></div>
    <div class="confirm-row"><span>Total debit cek fisik</span><span>-${totalDebit} pcs</span></div>
    <div class="confirm-row"><span>Saldo setelah ditulis</span><span>${formatNum(getCurrentSaldoValue() - totalDebit)} pcs</span></div>
  `;
  $('#confirmBtnLabel').textContent = 'Tulis Sekarang';
  openModal('#confirmModal');

  $('#btnConfirmWrite').onclick = () => executeImportWrite();
}

function getCurrentSaldoValue() {
  const raw = $('#saldoNum').textContent.replace(/\./g, '').replace(/,/g, '');
  const v = parseFloat(raw);
  return isNaN(v) ? 0 : v;
}

async function executeImportWrite() {
  const btn = $('#btnConfirmWrite');
  setButtonLoading(btn, true, 'Menulis…');

  try {
    const startRow = state.lastSaldoRow + 1; // baris pertama yang akan diisi
    const values = state.parsedDays.map((day, idx) => {
      const rowNum = startRow + idx;
      const prevRowNum = rowNum - 1;
      return [
        formatTanggalForSheet(day.dateObj),      // B: Tanggal
        day.fakturRange,                          // C: Nomor Faktur Penjualan
        '',                                        // D: Credit (kosong)
        day.debit,                                 // E: Debit
        `=IF(ISBLANK(B${rowNum}),"",F${prevRowNum}+D${rowNum}-E${rowNum})`, // F: Saldo (formula, konsisten dgn pola existing)
      ];
    });

    const range = `'${state.activeSheetName}'!B${startRow}:F${startRow + values.length - 1}`;

    // Jika ada baris "Saldo Akhir" di bawah, kita perlu insert baris baru agar tidak menimpanya
    if (state.saldoAkhirRow && startRow + values.length > state.saldoAkhirRow) {
      await insertRowsBeforeSaldoAkhir(values.length);
    }

    await sheetsFetch(`${state.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: JSON.stringify({ range, values }),
    });

    closeModal('#confirmModal');
    toast(`${values.length} baris berhasil ditulis ke ${state.activeSheetName}`, 'success');
    logSession('import', `${values.length} hari (${state.parsedDays.reduce((s,d)=>s+d.debit,0)} pcs debit)`);
    resetImportPanel();
    await loadActiveSheetContext();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Gagal menulis ke Sheets.', 'error');
  } finally {
    setButtonLoading(btn, false, 'Tulis Sekarang');
  }
}

/**
 * Sisipkan baris kosong sebelum "Saldo Akhir" jika data baru melebihi ruang yang tersedia.
 */
async function insertRowsBeforeSaldoAkhir(count) {
  const meta = await getSpreadsheetMeta();
  const sheetProps = meta.sheets.find(s => s.properties.title === state.activeSheetName).properties;
  const sheetId = sheetProps.sheetId;
  const insertAt = state.saldoAkhirRow - 1; // 0-indexed

  await sheetsFetch(`${state.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: insertAt, endIndex: insertAt + count },
          inheritFromBefore: true,
        }
      }]
    }),
  });
  state.saldoAkhirRow += count;
}

function resetImportPanel() {
  state.parsedDays = [];
  $('#previewCard').classList.add('hidden');
  $('#previewList').innerHTML = '';
  $('#btnUpload').classList.add('hidden');
  $('#btnUpload').disabled = true;
  $('#dropzone').classList.remove('has-file');
  $('#dzTitle').textContent = 'Ketuk untuk pilih file CSV';
  $('#dzSub').textContent = 'atau tarik & lepas di sini';
  $('#dzFilename').classList.add('hidden');
  $('#swipeStrip').classList.add('hidden');
  $('#swipeFill').style.width = '0%';
  $('#fileInput').value = '';
}

/* =========================================================================
   WRITE TO SHEETS — MANUAL (credit)
   ========================================================================= */
let selectedSource = 'SP-DRI';

function setupManualForm() {
  $$('#sourceChips .chip-opt').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('#sourceChips .chip-opt').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedSource = chip.dataset.src;
      updateManualFakturPlaceholder();
    });
  });

  const today = new Date();
  $('#manualDate').value = today.toISOString().slice(0, 10);

  [$('#manualFaktur'), $('#manualCredit'), $('#manualDate')].forEach(el => {
    el.addEventListener('input', validateManualForm);
  });

  $('#btnManualSubmit').addEventListener('click', confirmManualSubmit);
}

function updateManualFakturPlaceholder() {
  const field = $('#manualFaktur');
  if (selectedSource === 'SP-DRI') field.placeholder = 'Contoh: 0122/SP-DRI/V/25';
  else if (selectedSource === 'SP-CF') field.placeholder = 'Contoh: 64/SP-CF/25';
  else field.placeholder = 'Nomor referensi bebas';
}

function validateManualForm() {
  const faktur = $('#manualFaktur').value.trim();
  const credit = parseFloat($('#manualCredit').value);
  const date = $('#manualDate').value;
  $('#btnManualSubmit').disabled = !(faktur && credit > 0 && date);
}

function confirmManualSubmit() {
  const faktur = $('#manualFaktur').value.trim();
  const credit = parseFloat($('#manualCredit').value);
  const dateStr = $('#manualDate').value;
  const dateObj = new Date(dateStr + 'T00:00:00');

  $('#confirmSheetName').textContent = state.activeSheetName || '—';
  $('#confirmTable').innerHTML = `
    <div class="confirm-row"><span>Tanggal</span><span>${formatTanggalForSheet(dateObj)}</span></div>
    <div class="confirm-row"><span>Referensi</span><span>${faktur}</span></div>
    <div class="confirm-row"><span>Credit</span><span>+${formatNum(credit)} pcs</span></div>
    <div class="confirm-row"><span>Saldo setelah ditulis</span><span>${formatNum(getCurrentSaldoValue() + credit)} pcs</span></div>
  `;
  $('#confirmBtnLabel').textContent = 'Tulis Sekarang';
  openModal('#confirmModal');
  $('#btnConfirmWrite').onclick = () => executeManualWrite(dateObj, faktur, credit);
}

async function executeManualWrite(dateObj, faktur, credit) {
  const btn = $('#btnConfirmWrite');
  setButtonLoading(btn, true, 'Menulis…');
  try {
    const rowNum = state.lastSaldoRow + 1;
    const prevRowNum = rowNum - 1;
    const values = [[
      formatTanggalForSheet(dateObj),
      faktur,
      credit,
      '',
      `=IF(ISBLANK(B${rowNum}),"",F${prevRowNum}+D${rowNum}-E${rowNum})`,
    ]];
    const range = `'${state.activeSheetName}'!B${rowNum}:F${rowNum}`;

    if (state.saldoAkhirRow && rowNum >= state.saldoAkhirRow) {
      await insertRowsBeforeSaldoAkhir(1);
    }

    await sheetsFetch(`${state.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: JSON.stringify({ range, values }),
    });

    closeModal('#confirmModal');
    toast(`Credit ${formatNum(credit)} pcs berhasil ditulis`, 'success');
    logSession('manual', `+${formatNum(credit)} pcs (${faktur})`);

    $('#manualFaktur').value = '';
    $('#manualCredit').value = '';
    validateManualForm();

    await loadActiveSheetContext();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Gagal menulis ke Sheets.', 'error');
  } finally {
    setButtonLoading(btn, false, 'Tulis Sekarang');
  }
}

function logSession(type, desc) {
  state.sessionLog.unshift({ type, desc, time: new Date() });
  renderSessionLog();
}

function renderSessionLog() {
  const emptyHTML = `
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="none"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <p>Belum ada input yang tercatat pada sesi ini.</p>
    </div>`;

  const listHTML = state.sessionLog.length
    ? state.sessionLog.map(item => `
      <div class="day-row" style="margin-bottom:8px;">
        <div class="day-date">
          <b>${item.time.getHours().toString().padStart(2,'0')}:${item.time.getMinutes().toString().padStart(2,'0')}</b>
          <span>${item.type === 'import' ? 'IMPORT' : 'MANUAL'}</span>
        </div>
        <div class="day-info"><div class="faktur-range">${item.desc}</div></div>
      </div>
    `).join('')
    : emptyHTML;

  const sessionHistory = $('#sessionHistory');
  if (sessionHistory) sessionHistory.innerHTML = listHTML;
  const riwayatList = $('#riwayatList');
  if (riwayatList) riwayatList.innerHTML = listHTML;
}

/* =========================================================================
   MODALS
   ========================================================================= */
function openModal(sel) {
  const backdrop = $(sel);
  const sheet = backdrop.querySelector('.modal-sheet');
  if (sheet) {
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
  }
  backdrop.classList.add('show');
}
function closeModal(sel) {
  $(sel).classList.remove('show');
  const id = sel.replace('#', '');
  if (id === 'riwayatModal' || id === 'acctModal') setNavActive('home');
}

/* =========================================================================
   DRAG-TO-DISMISS (semua .modal-sheet)
   Bisa ditarik turun dari handle atau dari area sheet yang sedang tidak
   di-scroll, buat nutup modal atau geser modal yang tampilannya kepotong.
   ========================================================================= */
function setupModalDrag() {
  $$('.modal-backdrop').forEach(backdrop => {
    const sheet = backdrop.querySelector('.modal-sheet');
    if (!sheet) return;

    let dragging = false;
    let startY = 0;
    let deltaY = 0;

    const isBlockedTarget = (el) => {
      if (el.closest('.modal-handle')) return false; // handle selalu boleh drag
      return !!el.closest('input, textarea, select, button, .chip-opt');
    };

    const start = (y, target) => {
      if (sheet.scrollTop > 2) return false;      // sheet lagi di-scroll, jangan rebut gesture
      if (isBlockedTarget(target)) return false;   // hindari bentrok sama tap tombol/isi form
      dragging = true;
      startY = y;
      deltaY = 0;
      sheet.classList.add('dragging');
      return true;
    };
    const move = (y) => {
      if (!dragging) return;
      const d = y - startY;
      deltaY = d > 0 ? d : 0;
      sheet.style.transform = `translateY(${deltaY}px)`;
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      const threshold = Math.min(140, sheet.offsetHeight * 0.3);
      const shouldClose = deltaY > threshold;
      sheet.style.transform = '';
      deltaY = 0;
      if (shouldClose) {
        // modal setup awal (belum ada spreadsheet) wajib diisi dulu, tidak bisa di-drag tutup
        if (backdrop.id === 'setupModal' && !state.spreadsheetId) return;
        closeModal(`#${backdrop.id}`);
      }
    };

    sheet.addEventListener('touchstart', (e) => start(e.touches[0].clientY, e.target), { passive: true });
    sheet.addEventListener('touchmove', (e) => { if (dragging) move(e.touches[0].clientY); }, { passive: true });
    sheet.addEventListener('touchend', end);
    sheet.addEventListener('touchcancel', end);

    sheet.addEventListener('mousedown', (e) => {
      if (!start(e.clientY, e.target)) return;
      const onMouseMove = (ev) => move(ev.clientY);
      const onMouseUp = () => {
        end();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}

function setupModals() {
  $('#btnConfirmCancel').addEventListener('click', () => closeModal('#confirmModal'));
  $('#confirmModal').addEventListener('click', (e) => { if (e.target.id === 'confirmModal') closeModal('#confirmModal'); });

  $('#riwayatModal').addEventListener('click', (e) => { if (e.target.id === 'riwayatModal') closeModal('#riwayatModal'); });

  $('#btnSetupSave').addEventListener('click', async () => {
    const raw = $('#setupSheetId').value.trim();
    const id = extractSheetIdFromInput(raw);
    if (!id) { toast('ID/URL spreadsheet tidak valid.', 'error'); return; }
    state.spreadsheetId = id;
    localStorage.setItem(STORAGE_KEYS.sheetId, id);
    closeModal('#setupModal');
    toast('Spreadsheet terhubung.', 'success');
    await loadActiveSheetContext();
  });
  $('#setupModal').addEventListener('click', (e) => {
    if (e.target.id === 'setupModal' && state.spreadsheetId) closeModal('#setupModal');
  });
}

function extractSheetIdFromInput(input) {
  if (!input) return null;
  const urlMatch = input.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(input)) return input;
  return null;
}

/* =========================================================================
   TABS
   ========================================================================= */
function setTab(tab) {
  state.activeTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#tabIndicator').classList.toggle('pos-1', tab === 'manual');
  $('#panelImport').classList.toggle('active', tab === 'import');
  $('#panelManual').classList.toggle('active', tab === 'manual');
}

function setupTabs() {
  $('#tabImport').addEventListener('click', () => setTab('import'));
  $('#tabManual').addEventListener('click', () => setTab('manual'));
}

/* =========================================================================
   BOTTOM NAV — Beranda / Riwayat / Akun
   ========================================================================= */
const NAV_ORDER = ['home', 'riwayat', 'akun'];

function setNavActive(navKey) {
  const idx = NAV_ORDER.indexOf(navKey);
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === navKey));
  const indicator = $('#bnIndicator');
  if (indicator) indicator.className = `bn-indicator pos-${idx < 0 ? 0 : idx}`;
}

function setupBottomNav() {
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      if (nav === 'home') {
        setNavActive('home');
        setTab('import');
        $('.scroll').scrollTo({ top: 0, behavior: 'smooth' });
      } else if (nav === 'riwayat') {
        setNavActive('riwayat');
        openModal('#riwayatModal');
      } else if (nav === 'akun') {
        setNavActive('akun');
        openAcctModal();
      }
    });
  });
  setNavActive('home');
}

/* =========================================================================
   THEME TOGGLE (terang/gelap)
   ========================================================================= */
function setupThemeToggle() {
  const btn = $('#themeToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    btn.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
    const mc = document.getElementById('metaThemeColor');
    if (mc) mc.setAttribute('content', next === 'light' ? '#F4F2EC' : '#0B0F0D');
    try { localStorage.setItem('inges_theme', next); } catch (e) { /* non-fatal */ }
  });
  btn.setAttribute('aria-pressed', document.documentElement.getAttribute('data-theme') === 'light' ? 'true' : 'false');
}

/* =========================================================================
   BUTTON LOADING STATE
   ========================================================================= */
function setButtonLoading(btn, loading, label) {
  btn.disabled = loading;
  if (loading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.innerHTML = `<div class="spinner"></div><span>${label}</span>`;
  } else {
    btn.innerHTML = btn.dataset.originalHtml || `<span>${label}</span>`;
  }
}

/* =========================================================================
   INIT
   ========================================================================= */
function init() {
  $('#btnSignIn').addEventListener('click', requestSignIn);
  setupDropzone();
  setupManualForm();
  setupModals();
  setupAcctModal();
  setupModalDrag();
  setupTabs();
  setupBottomNav();
  setupThemeToggle();

  $('#btnUpload').addEventListener('click', confirmAndUploadImport);

  updateManualFakturPlaceholder();
  renderSessionLog();
  initGoogleAuth();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
