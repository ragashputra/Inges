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
  sessionLog: 'inges_session_log',
  lockedSheet: 'inges_locked_sheet',       // nama sheet bulan yang dikunci manual oleh user
  lockedFakturSuffix: 'inges_locked_faktur_suffix', // kode faktur (mis. PGR/VII/2026) yang dikunci manual
  hadSession: 'inges_had_session',         // penanda "pernah login sebelumnya" - dipakai buat auto-relogin diam-diam
};

const SESSION_LOG_MAX_ENTRIES = 200; // batas biar localStorage tidak membengkak tak terbatas

// Nama bulan Indonesia -> dipakai untuk menentukan nama sheet aktif otomatis
const BULAN_ID = ['JAN','FEB','MAR','APR','MEI','JUN','JUL','AGTS','SEPT','OKT','NOV','DES'];
const BULAN_ID_LONG = ['JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI','JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER'];

/* ---------------- STATE ---------------- */
const state = {
  accessToken: null,
  tokenClient: null,
  userWantsSignIn: false,    // true kalau user sendiri yang klik tombol login (buat tahu kapan boleh tampilkan toast error)
  userEmail: null,
  userPicture: null,
  spreadsheetId: null,
  spreadsheetLocale: null,
  formulaSep: ';',           // pemisah argumen formula — dideteksi otomatis dari locale spreadsheet
  activeSheetName: null,
  lockedSheetName: null,     // kalau terisi, dipakai terus lintas reload/tutup PWA sampai diganti/dilepas
  autoCreatePromptDismissedFor: null, // nama sheet yang tawaran auto-buatnya sudah ditutup user di sesi ini
  availableSheets: [],
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

/**
 * Format tanggal LOKAL (bukan UTC) jadi "YYYY-MM-DD" buat isian <input type=date>.
 * date.toISOString() salah dipakai di sini karena dia geser ke UTC — untuk
 * pengguna WIB/WITA/WIT, itu bisa bikin tanggal default "hari ini" jadi
 * kemarin di jam-jam dini hari. Fungsi ini selalu mengikuti tanggal
 * kalender lokal perangkat, sesuai jam saat itu.
 */
function todayLocalISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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
      // kalau ini percobaan restore sesi diam-diam (bukan klik manual user),
      // jangan tampilkan error — cukup balik ke layar login biasa tanpa drama.
      if (state.userWantsSignIn) {
        toast('Gagal masuk. Coba lagi.', 'error');
      }
      showSignInGate();
    }
  });

  // cek token tersimpan (belum expired) -> langsung lanjut, tidak perlu login ulang
  const savedToken = localStorage.getItem(STORAGE_KEYS.token);
  const savedExp = parseInt(localStorage.getItem(STORAGE_KEYS.tokenExp) || '0', 10);
  const hadSession = localStorage.getItem(STORAGE_KEYS.hadSession) === '1';

  if (savedToken && Date.now() < savedExp) {
    state.accessToken = savedToken;
    afterSignIn();
  } else if (hadSession) {
    // token sudah kedaluwarsa tapi user pernah login sebelumnya (dan belum logout manual)
    // -> coba sambung ulang otomatis di belakang layar, tanpa memaksa user klik login lagi.
    state.userWantsSignIn = false;
    showAuthRestoring();
    state.tokenClient.requestAccessToken({ prompt: '' });
  } else {
    showSignInGate();
  }
}

/**
 * Tampilkan layar gate dalam mode "menyambungkan sesi" (spinner, tanpa
 * tombol login) selagi Inges mencoba me-refresh token secara diam-diam.
 */
function showAuthRestoring() {
  const text = $('#gateText');
  const spinner = $('#gateSpinner');
  const btn = $('#btnSignIn');
  const foot = $('#gateFoot');
  if (text) text.textContent = 'Menyambungkan sesi kamu…';
  if (spinner) spinner.classList.remove('hidden');
  if (btn) btn.classList.add('hidden');
  if (foot) foot.classList.add('hidden');
  $('#gate').classList.remove('hidden');
  $('#mainContent').classList.add('hidden');
  $('#bottomnav').classList.add('hidden');
}

/**
 * Kembalikan layar gate ke tampilan login normal (dipakai kalau restore
 * sesi diam-diam gagal, atau memang belum pernah login sama sekali).
 */
function showSignInGate() {
  const text = $('#gateText');
  const spinner = $('#gateSpinner');
  const btn = $('#btnSignIn');
  const foot = $('#gateFoot');
  if (text) text.textContent = 'Rekap cek fisik dari listing penjualan langsung ke Google Sheets. Masuk dengan akun Google untuk mulai.';
  if (spinner) spinner.classList.add('hidden');
  if (btn) btn.classList.remove('hidden');
  if (foot) foot.classList.remove('hidden');
  $('#gate').classList.remove('hidden');
}

function onTokenReceived(resp) {
  if (resp.error) {
    toast('Otorisasi ditolak.', 'error');
    showSignInGate();
    return;
  }
  state.accessToken = resp.access_token;
  const expiresInMs = (resp.expires_in || 3500) * 1000;
  localStorage.setItem(STORAGE_KEYS.token, resp.access_token);
  localStorage.setItem(STORAGE_KEYS.tokenExp, String(Date.now() + expiresInMs - 60000));
  localStorage.setItem(STORAGE_KEYS.hadSession, '1');
  afterSignIn();
}

function requestSignIn() {
  if (!state.tokenClient) {
    toast('Google belum siap, coba lagi sebentar.', 'error');
    initGoogleAuth();
    return;
  }
  state.userWantsSignIn = true;
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

  state.lockedSheetName = localStorage.getItem(STORAGE_KEYS.lockedSheet) || null;

  const savedSheetId = localStorage.getItem(STORAGE_KEYS.sheetId);
  if (savedSheetId) {
    state.spreadsheetId = savedSheetId;
    await loadActiveSheetContext();
  } else {
    openModal('#setupModal');
  }
}

/**
 * "Kunci" sheet aktif — dipakai setiap kali user memilih sheet secara manual
 * (lewat modal pilih sheet atau dropdown di panel import), supaya Inges
 * tetap memakai sheet itu walau di-reload / PWA ditutup dan dibuka lagi,
 * alih-alih balik ke auto-detect bulan berjalan.
 */
function lockSheet(name) {
  state.lockedSheetName = name;
  localStorage.setItem(STORAGE_KEYS.lockedSheet, name);
  refreshSheetLockUI();
}

function unlockSheet() {
  state.lockedSheetName = null;
  localStorage.removeItem(STORAGE_KEYS.lockedSheet);
  refreshSheetLockUI();
}

function renderAcctChip() {
  const area = $('#acctArea');
  area.innerHTML = `
    <button class="acct-chip" id="acctChipBtn">
      ${state.userPicture ? `<img src="${state.userPicture}" alt="">` : '<span class="acct-dot"></span>'}
      <span>${(state.userEmail || 'Akun').split('@')[0]}</span>
    </button>`;
  $('#acctChipBtn').addEventListener('click', goToAkunPage);
}

function goToAkunPage() {
  setNavActive('akun');
  setActivePage('akun');
}

/**
 * Isi halaman Akun (bukan lagi modal) dengan data profil & status kunci sheet.
 */
function renderAkunPage() {
  $('#acctPageEmail').textContent = state.userEmail || 'Akun Google';
  $('#acctPageSheetLabel').textContent = state.activeSheetName
    ? `Terhubung ke sheet ${state.activeSheetName}`
    : 'Spreadsheet belum terhubung';

  const pic = $('#acctPagePic');
  const dot = $('#acctPageDot');
  if (state.userPicture) {
    pic.src = state.userPicture;
    pic.classList.remove('hidden');
    dot.classList.add('hidden');
  } else {
    pic.classList.add('hidden');
    dot.classList.remove('hidden');
  }
  refreshSheetLockUI();
}

/**
 * Sinkronkan semua indikator visual status kunci sheet: pill bulan di
 * beranda dan kartu status di halaman Akun.
 */
function refreshSheetLockUI() {
  const locked = !!state.lockedSheetName;

  const pill = $('#monthPill');
  if (pill) {
    const lockIcon = '<svg viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    pill.innerHTML = `${locked ? lockIcon : ''}<span>${state.activeSheetName || '—'}</span>`;
    pill.classList.toggle('locked', locked);
  }

  const sheetName = $('#acctPageSheet');
  if (sheetName) sheetName.textContent = state.activeSheetName || 'Belum ada sheet aktif';
  const statusText = $('#lockStatusText');
  if (statusText) {
    statusText.textContent = locked ? 'Terkunci — tidak ikut pindah otomatis' : 'Mengikuti bulan berjalan otomatis';
    statusText.classList.toggle('locked', locked);
  }
  const btnUnlock = $('#btnUnlockSheet');
  if (btnUnlock) btnUnlock.classList.toggle('hidden', !locked);
}

function setupAkunPage() {
  $('#btnChangeSheet').addEventListener('click', () => {
    openModal('#setupModal');
  });

  $('#btnPickSheet').addEventListener('click', openSheetPicker);

  $('#btnUnlockSheet').addEventListener('click', async () => {
    unlockSheet();
    toast('Sheet mengikuti bulan berjalan otomatis lagi.', 'success', 2400);
    await loadActiveSheetContext();
  });

  $('#btnLogout').addEventListener('click', doLogout);
}

/**
 * Modal pilih sheet bulan — dipakai kalau user mau menulis ke bulan
 * selain bulan berjalan (koreksi data lampau, dsb), bukan cuma andalkan
 * auto-detect nama bulan aktif.
 */
async function openSheetPicker() {
  openModal('#sheetPickerModal');
  const listEl = $('#sheetPickerList');
  listEl.innerHTML = `
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <p>Memuat daftar sheet…</p>
    </div>`;

  try {
    if (!state.availableSheets.length) await findActiveSheet();
    renderSheetPickerList();
  } catch (err) {
    listEl.innerHTML = `<div class="empty"><p>${err.message || 'Gagal memuat daftar sheet.'}</p></div>`;
  }
}

function renderSheetPickerList() {
  const listEl = $('#sheetPickerList');
  if (!state.availableSheets.length) {
    listEl.innerHTML = '<div class="empty"><p>Tidak ada sheet ditemukan.</p></div>';
    return;
  }
  // tampilkan yang terbaru duluan — sheet bulan berjalan biasanya di akhir daftar
  const ordered = state.availableSheets.slice().reverse();
  listEl.innerHTML = ordered.map(name => {
    const isActive = name === state.activeSheetName;
    return `
      <div class="sheet-picker-item ${isActive ? 'active' : ''}" data-sheet="${name}">
        <b>${name}</b>
        ${isActive
          ? '<span class="badge-active">Aktif</span>'
          : '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
      </div>`;
  }).join('');

  $$('.sheet-picker-item').forEach(item => {
    item.addEventListener('click', async () => {
      const chosen = item.dataset.sheet;
      closeModal('#sheetPickerModal');
      lockSheet(chosen);
      if (chosen === state.activeSheetName) {
        toast(`Sheet ${chosen} dikunci.`, 'success', 1800);
        return;
      }
      toast(`Berpindah & mengunci sheet ${chosen}…`, 'success', 1800);
      await loadActiveSheetContext(chosen);
    });
  });
}

function doLogout() {
  const token = state.accessToken;

  const finishLogout = () => {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.tokenExp);
    localStorage.removeItem(STORAGE_KEYS.hadSession);
    state.accessToken = null;
    state.userEmail = null;
    state.userPicture = null;
    state.activeSheetName = null;

    $('#acctArea').innerHTML = '';
    $('#mainContent').classList.add('hidden');
    $('#bottomnav').classList.add('hidden');
    showSignInGate();
    setNavActive('home');
    setActivePage('home');
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
    // token expired di tengah sesi -> coba refresh diam-diam dulu, jangan langsung
    // lempar ke layar login supaya tidak terasa "berulang-ulang login"
    localStorage.removeItem(STORAGE_KEYS.token);
    toast('Sesi diperbarui, mencoba lagi…', 'success', 2200);
    state.userWantsSignIn = false;
    state.tokenClient?.requestAccessToken({ prompt: '' });
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
  return sheetsFetch(`${state.spreadsheetId}?fields=properties.locale,sheets.properties`);
}

/**
 * Google Sheets pakai koma (,) sebagai pemisah argumen formula untuk locale
 * berbahasa Inggris, tapi titik-koma (;) untuk mayoritas locale non-Inggris
 * termasuk Indonesia (id_ID). Salah pakai separator membuat SEMUA formula
 * yang ditulis lewat API gagal parse dan tampil #ERROR! di seluruh baris.
 * Fungsi ini mendeteksi locale asli spreadsheet sekali di awal sesi,
 * supaya formula yang kita tulis selalu cocok — bukan menebak.
 */
function formulaSeparatorForLocale(locale) {
  const commaLocales = new Set(['en_US', 'en_GB', 'en', 'en_CA', 'en_AU', 'en_IE', 'en_ZA']);
  if (!locale) return ';'; // default aman: mayoritas dunia (termasuk id_ID) pakai titik-koma
  return commaLocales.has(locale) ? ',' : ';';
}

/**
 * Bangun formula Saldo persis mengikuti pola yang sudah dipakai di sheet
 * ("=IF(ISBLANK(E7);"";F6+D7-E7)"), dengan separator yang sudah disesuaikan
 * ke locale spreadsheet aktif (state.formulaSep) supaya tidak pernah #ERROR!.
 */
function buildSaldoFormula(rowNum, prevRowNum) {
  const s = state.formulaSep;
  return `=IF(ISBLANK(E${rowNum})${s}""${s}F${prevRowNum}+D${rowNum}-E${rowNum})`;
}

/**
 * Ambil daftar sheet & locale spreadsheet, simpan ke state. Dipisah dari
 * deteksi "sheet mana yang dipakai" supaya bisa dipanggil ulang saat perlu
 * cek validitas sheet yang terkunci tanpa langsung menimpa pilihan user.
 */
async function loadSpreadsheetMeta() {
  const meta = await getSpreadsheetMeta();
  const sheetNames = meta.sheets.map(s => s.properties.title);
  state.spreadsheetLocale = meta.properties?.locale || null;
  state.formulaSep = formulaSeparatorForLocale(state.spreadsheetLocale);
  state.availableSheets = sheetNames;
  return sheetNames;
}

/**
 * Tentukan nama sheet bulan berjalan dari daftar sheet yang tersedia
 * (auto-detect murni, tidak peduli status kunci).
 */
function detectPreferredSheetName(sheetNames) {
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
 * Baca & parse struktur sebuah sheet (baris header, baris "Saldo Akhir",
 * saldo awal, baris data terakhir, saldo & rekap saat ini). Dipisah dari
 * loadActiveSheetContext supaya bisa dipakai ulang untuk sheet manapun —
 * termasuk sheet template saat membuat sheet bulan baru.
 */
/**
 * Konversi index kolom (0-based) ke huruf kolom spreadsheet (0->A, 1->B, ... 26->AA).
 */
function colLetter(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function readSheetStructure(sheetName) {
  const range = `'${sheetName}'!A1:F200`;
  const data = await sheetsFetch(`${state.spreadsheetId}/values/${encodeURIComponent(range)}`);
  const rows = data.values || [];

  let headerRow = -1;
  let saldoAkhirRow = -1;
  let periodeRow = -1, periodeCol = -1, periodeText = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r && r[1] === 'Tanggal' && r[2] === 'Nomor Faktur Penjualan') headerRow = i;
    if (r && r[1] === 'Saldo Akhir') { saldoAkhirRow = i; break; }
    if (periodeRow === -1 && r) {
      const col = r.findIndex(c => c !== null && c !== undefined && c !== '' && /periode/i.test(String(c)));
      if (col > -1) { periodeRow = i; periodeCol = col; periodeText = String(r[col]); }
    }
  }
  if (headerRow === -1) throw new Error(`Header kolom tidak ditemukan di sheet ${sheetName}.`);

  const saldoAwalRow = rows[headerRow + 1] || [];
  const saldoAwal = parseFloat(saldoAwalRow[5]) || 0;

  let lastFilled = headerRow + 1; // minimal saldo-awal row
  const scanEnd = saldoAkhirRow > -1 ? saldoAkhirRow : rows.length;
  for (let i = headerRow + 2; i < scanEnd; i++) {
    const r = rows[i];
    if (r && (r[1] || r[2] || r[3] || r[4])) lastFilled = i;
  }

  // hitung current saldo dari kolom F baris terakhir yg terisi.
  // Kalau cell itu berisi error formula (#ERROR!, #REF!, dst), mundur ke
  // baris valid terakhir supaya nilainya tetap akurat, bukan NaN.
  let currentSaldo = NaN;
  for (let i = lastFilled; i >= headerRow + 1; i--) {
    const v = (rows[i] || [])[5];
    if (v === undefined || v === '') continue;
    const n = parseFloat(v);
    if (!isNaN(n)) { currentSaldo = n; break; }
  }
  if (isNaN(currentSaldo)) currentSaldo = saldoAwal;

  let totalCredit = 0, totalDebit = 0;
  for (let i = headerRow + 2; i <= lastFilled; i++) {
    const r = rows[i];
    if (!r) continue;
    totalCredit += parseFloat(r[3]) || 0;
    totalDebit += parseFloat(r[4]) || 0;
  }

  return {
    rows, headerRow, saldoAkhirRow, lastFilled, saldoAwal, currentSaldo, totalCredit, totalDebit,
    headerRow1: headerRow + 1,                                   // 1-indexed baris header
    saldoAkhirRow1: saldoAkhirRow > -1 ? saldoAkhirRow + 1 : null, // 1-indexed baris "Saldo Akhir"
    lastSaldoRow1: lastFilled + 1,                                 // 1-indexed baris data/saldo-awal terakhir
    periodeRow1: periodeRow > -1 ? periodeRow + 1 : null,          // 1-indexed baris judul "Periode ..."
    periodeCol, periodeText,
  };
}

/**
 * Ambil "Saldo Akhir" (kolom biru, baris paling bawah tiap sheet) dari sheet
 * bulan sebelumnya langsung dari spreadsheet — bukan dari angka yang ditulis
 * manual di baris saldo-awal (F7) sheet aktif. Sheet sebelumnya ditentukan dari
 * urutan tab asli di spreadsheet (state.availableSheets), sesuai urutan
 * kronologis yang sudah dipakai user.
 */
async function fetchPreviousMonthEndingSaldo(sheetName) {
  const idx = state.availableSheets.indexOf(sheetName);
  if (idx <= 0) return null; // sheet pertama / tidak ditemukan -> tidak ada bulan sebelumnya
  const prevName = state.availableSheets[idx - 1];
  try {
    const prevStruct = await readSheetStructure(prevName);
    return isNaN(prevStruct.currentSaldo) ? null : prevStruct.currentSaldo;
  } catch (e) {
    console.warn('Gagal membaca Saldo Akhir sheet sebelumnya:', prevName, e);
    return null;
  }
}

/**
 * Terapkan struktur sheet yang sudah dibaca ke state & UI (ringkasan saldo,
 * dropdown sheet, peringatan formula error).
 */
async function applySheetStructureToState(struct, sheetName) {
  state.activeSheetHeaderRow = struct.headerRow1;
  state.lastSaldoRow = struct.lastSaldoRow1;
  state.saldoAkhirRow = struct.saldoAkhirRow1;

  // "Saldo bulan lalu" = Saldo Akhir (kolom biru) sheet bulan sebelumnya,
  // dibaca otomatis dari spreadsheet. Fallback ke F7 sheet aktif kalau sheet
  // sebelumnya tidak ada / gagal dibaca.
  const prevEndingSaldo = await fetchPreviousMonthEndingSaldo(sheetName);
  state.saldoAwal = prevEndingSaldo !== null ? prevEndingSaldo : struct.saldoAwal;

  updateSummary(struct.currentSaldo, struct.totalCredit, struct.totalDebit, state.saldoAwal);
  populateImportSheetSelect();

  // Peringatkan pengguna kalau ada baris Saldo berisi error formula —
  // kemungkinan besar butuh diperbaiki manual di sheet (mis. locale formula lama).
  const hasFormulaError = struct.rows.slice(struct.headerRow + 1, struct.lastFilled + 1)
    .some(r => typeof (r || [])[5] === 'string' && (r[5].includes('#ERROR') || r[5].includes('#REF') || r[5].includes('#N/A')));
  if (hasFormulaError) {
    toast('Ada baris Saldo berisi error formula di sheet ini — cek manual sebelum menulis data baru.', 'error', 5500);
  }
}

async function findActiveSheet() {
  const sheetNames = await loadSpreadsheetMeta();
  return detectPreferredSheetName(sheetNames);
}

/**
 * Baca struktur sheet aktif dan terapkan ke UI. Kalau tidak ada override
 * dan sheet bulan berjalan ternyata belum ada di spreadsheet, tetap tampilkan
 * sheet terbaru yang ada sebagai fallback sementara, lalu tawarkan pembuatan
 * sheet baru otomatis (sekali per nama sheet per sesi, tidak nge-spam).
 */
async function loadActiveSheetContext(overrideSheetName) {
  try {
    let targetName;
    let sheetMissing = null;

    if (overrideSheetName) {
      // pastikan locale & daftar sheet tetap ter-refresh walau memilih sheet manual
      if (!state.availableSheets.length || !state.spreadsheetLocale) await loadSpreadsheetMeta();
      targetName = overrideSheetName;
    } else {
      const sheetNames = await loadSpreadsheetMeta();
      if (state.lockedSheetName && sheetNames.includes(state.lockedSheetName)) {
        // sheet yang dikunci user masih ada -> tetap pakai itu, jangan auto-pindah bulan
        targetName = state.lockedSheetName;
      } else {
        if (state.lockedSheetName) {
          // sheet yang dikunci sudah tidak ada lagi (dihapus/diganti nama) -> lepas kunci basi
          unlockSheet();
        }
        const exactPreferred = currentMonthSheetName();
        if (sheetNames.includes(exactPreferred)) {
          targetName = exactPreferred;
        } else {
          targetName = detectPreferredSheetName(sheetNames);
          sheetMissing = exactPreferred;
        }
      }
    }

    state.activeSheetName = targetName;
    refreshSheetLockUI();

    const struct = await readSheetStructure(targetName);
    await applySheetStructureToState(struct, targetName);

    if (sheetMissing && state.autoCreatePromptDismissedFor !== sheetMissing) {
      openCreateSheetModal(sheetMissing);
    }
  } catch (e) {
    console.error(e);
    toast(e.message || 'Gagal membaca spreadsheet.', 'error');
  }
}

/**
 * Isi dropdown pemilihan sheet tujuan di panel Cek Fisik Keluar (import CSV),
 * supaya pengguna bisa memastikan / mengganti bulan tujuan sebelum menulis —
 * tidak melulu bergantung pada auto-detect bulan berjalan.
 */
function populateImportSheetSelect() {
  const select = $('#importSheetSelect');
  if (!select) return;
  if (!state.availableSheets.length) {
    select.innerHTML = '<option value="">Tidak ada sheet ditemukan</option>';
    return;
  }
  const ordered = state.availableSheets.slice().reverse(); // sheet terbaru duluan
  select.innerHTML = ordered.map(name =>
    `<option value="${name}" ${name === state.activeSheetName ? 'selected' : ''}>${name}</option>`
  ).join('');
}

function setupImportSheetSelect() {
  const select = $('#importSheetSelect');
  if (!select) return;
  select.addEventListener('change', async () => {
    const chosen = select.value;
    if (!chosen || chosen === state.activeSheetName) return;

    // Preview yang sudah dihitung berasal dari konteks sheet lama (row target beda),
    // jadi harus direset supaya tidak salah tulis ke sheet yang baru dipilih.
    const hadPreview = state.parsedDays.length > 0;
    resetImportPanel();

    lockSheet(chosen);
    toast(`Berpindah & mengunci sheet ${chosen}…`, 'success', 1800);
    await loadActiveSheetContext(chosen);

    if (hadPreview) {
      toast('Pratinjau sebelumnya direset — silakan upload ulang CSV untuk sheet ini.', 'success', 3500);
    }
  });
}

function updateSummary(saldo, credit, debit, saldoAwal) {
  const num = $('#saldoNum');
  if (isNaN(saldo)) {
    num.textContent = '—';
    num.classList.remove('neg');
  } else {
    num.textContent = formatNum(saldo);
    num.classList.toggle('neg', saldo < 0);
  }
  $('#statCredit').textContent = formatNum(credit);
  $('#statDebit').textContent = formatNum(debit);
  $('#statPrevSaldo').textContent = isNaN(saldoAwal) ? '—' : formatNum(saldoAwal);
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

/**
 * Bangun range nomor faktur untuk input cepat manual (bukan dari CSV) —
 * PIC cukup isi nomor faktur awal + jumlah unit terjual, Inges menghitung
 * nomor akhir dan merangkainya dengan format yang sama seperti hasil import CSV.
 * Contoh: startNum=252, unitCount=4, suffix="PGR/VII/2026"
 *         -> "252-255/PGR/VII/2026"
 */
function buildQuickFakturRange(startNum, unitCount, suffix) {
  const cleanSuffix = suffix.replace(/^\/+/, ''); // buang slash di depan kalau PIC ikut mengetiknya
  const pad4 = (n) => String(n).padStart(4, '0');
  if (unitCount <= 1) return `${pad4(startNum)}/${cleanSuffix}`;
  const endNum = startNum + unitCount - 1;
  return `${pad4(startNum)}-${pad4(endNum)}/${cleanSuffix}`;
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

/**
 * Sub-tab di panel "Cek Fisik Keluar": Upload CSV (batch, dari export
 * program) vs Input Cepat (manual, satu kali entri langsung dari PIC
 * tanpa perlu menunggu file CSV). Keduanya menulis ke struktur
 * state.parsedDays yang sama, jadi bisa dicampur dalam satu sesi
 * (mis. upload CSV lalu tambah 1 transaksi susulan secara manual)
 * sebelum benar-benar ditulis ke Google Sheets.
 */
function setupImportSubTabs() {
  const chipCsv = $('#subChipCsv');
  const chipManual = $('#subChipManual');
  const subCsv = $('#subImportCsv');
  const subManual = $('#subImportManual');
  const desc = $('#importSubDesc');

  const descCsv = 'Upload listing penjualan untuk mencatat pemakaian cek fisik. Inges mengelompokkan otomatis per tanggal dan setiap 1 unit SMH terpakai 2 pcs cek fisik.';
  const descManual = 'Input langsung kalau ada penjualan hari ini dan belum sempat export CSV. Cukup isi tanggal, jumlah unit, dan nomor faktur awal — Inges menghitung sisanya.';

  chipCsv.addEventListener('click', () => {
    chipCsv.classList.add('active');
    chipManual.classList.remove('active');
    subCsv.classList.remove('hidden');
    subManual.classList.add('hidden');
    desc.textContent = descCsv;
  });

  chipManual.addEventListener('click', () => {
    chipManual.classList.add('active');
    chipCsv.classList.remove('active');
    subManual.classList.remove('hidden');
    subCsv.classList.add('hidden');
    desc.textContent = descManual;
  });
}

function setupQuickEntry() {
  const dateEl = $('#quickDate');
  const unitEl = $('#quickUnitCount');
  const fakturStartEl = $('#quickFakturStart');
  const suffixEl = $('#quickFakturSuffix');
  const previewBox = $('#quickPreviewBox');
  const btnAdd = $('#btnQuickAdd');
  const btnLock = $('#btnLockFakturSuffix');
  const lockIcon = $('#fakturLockIcon');
  const lockBadge = $('#fakturLockBadge');
  const lockBadgeText = $('#fakturLockBadgeText');
  const lockHint = $('#fakturLockHint');
  const inputLockIcon = $('#fakturInputLockIcon');

  const iconLocked = '<rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  const iconUnlocked = '<rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 017.5-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

  const defaultSuffix = () => `PGR/${toRomanMonth(new Date().getMonth() + 1)}/${new Date().getFullYear()}`;

  const savedSuffix = localStorage.getItem(STORAGE_KEYS.lockedFakturSuffix);
  let suffixLocked = !!savedSuffix;

  const refreshLockUI = () => {
    btnLock.classList.toggle('locked', suffixLocked);
    lockIcon.innerHTML = suffixLocked ? iconLocked : iconUnlocked;
    btnLock.title = suffixLocked ? 'Kode faktur terkunci — klik buat lepas & edit lagi' : 'Kunci kode faktur biar nggak berubah saat reload';

    // kolom kode faktur sendiri jadi tidak bisa diketik selama terkunci —
    // satu-satunya cara edit adalah lepas kunci dulu lewat tombol gembok.
    suffixEl.readOnly = suffixLocked;
    suffixEl.classList.toggle('is-locked', suffixLocked);
    suffixEl.setAttribute('aria-readonly', String(suffixLocked));

    if (lockBadge) lockBadge.classList.toggle('locked', suffixLocked);
    if (lockBadgeText) lockBadgeText.textContent = suffixLocked ? 'Terkunci' : 'Otomatis';
    if (inputLockIcon) inputLockIcon.classList.toggle('show', suffixLocked);
    if (lockHint) {
      lockHint.textContent = suffixLocked
        ? 'Terkunci — kode ini dipakai terus walau reload. Klik gembok buat edit.'
        : 'Ikut bulan & tahun berjalan otomatis. Klik gembok buat mengunci.';
      lockHint.classList.toggle('locked', suffixLocked);
    }
  };

  // default: tanggal hari ini. Kode faktur pakai yang dikunci kalau ada,
  // kalau nggak ikut bulan-romawi & tahun berjalan seperti biasa.
  dateEl.value = todayLocalISO();
  suffixEl.value = suffixLocked ? savedSuffix : defaultSuffix();
  refreshLockUI();

  btnLock.addEventListener('click', () => {
    suffixLocked = !suffixLocked;
    if (suffixLocked) {
      localStorage.setItem(STORAGE_KEYS.lockedFakturSuffix, suffixEl.value.trim());
      toast(`Kode faktur dikunci: ${suffixEl.value.trim()}`, 'success', 2200);
    } else {
      localStorage.removeItem(STORAGE_KEYS.lockedFakturSuffix);
      suffixEl.value = defaultSuffix();
      toast('Kode faktur nggak dikunci lagi — ikut bulan berjalan otomatis.', 'success', 2200);
      revalidate();
    }
    refreshLockUI();
  });

  // No. Faktur Awal wajib angka doang, maksimal 4 digit — auto-bersihkan
  // karakter non-angka & potong kelebihan panjang saat user mengetik.
  fakturStartEl.addEventListener('input', () => {
    const cleaned = fakturStartEl.value.replace(/\D/g, '').slice(0, 4);
    if (cleaned !== fakturStartEl.value) fakturStartEl.value = cleaned;
  });

  // kalau kode faktur lagi terkunci, tetap kasih tahu kenapa nggak bisa
  // diketik alih-alih diem aja seolah rusak — dorong perhatian ke tombol gembok.
  suffixEl.addEventListener('focus', () => {
    if (suffixLocked) {
      suffixEl.blur();
      toast('Kode faktur terkunci. Klik ikon gembok buat membuka & mengedit.', 'success', 2600);
      btnLock.classList.add('shake');
      setTimeout(() => btnLock.classList.remove('shake'), 420);
    }
  });

  const revalidate = () => {
    const unitCount = parseInt(unitEl.value, 10);
    const fakturStartRaw = fakturStartEl.value.trim();
    const startNum = parseInt(fakturStartRaw, 10);
    const suffix = suffixEl.value.trim();
    const dateVal = dateEl.value;

    // selagi dikunci, ikutin terus perubahan yang diketik user
    if (suffixLocked) localStorage.setItem(STORAGE_KEYS.lockedFakturSuffix, suffix);

    // no. faktur awal wajib persis 4 digit angka
    const fakturStartValid = /^\d{4}$/.test(fakturStartRaw);
    const valid = dateVal && unitCount > 0 && fakturStartValid && suffix.length > 0;
    btnAdd.disabled = !valid;

    if (valid) {
      const range = buildQuickFakturRange(startNum, unitCount, suffix);
      const debit = unitCount * 2;
      $('#quickPreviewRange').textContent = range;
      $('#quickPreviewDebit').textContent = `-${debit} pcs`;
      previewBox.classList.remove('hidden');
    } else {
      previewBox.classList.add('hidden');
    }
  };

  [dateEl, unitEl, fakturStartEl, suffixEl].forEach(el => el.addEventListener('input', revalidate));
  revalidate();

  btnAdd.addEventListener('click', () => {
    const unitCount = parseInt(unitEl.value, 10);
    const startNum = parseInt(fakturStartEl.value, 10);
    const suffix = suffixEl.value.trim();
    const dateObj = new Date(dateEl.value + 'T00:00:00');

    const entry = {
      tanggalRaw: formatTanggalForSheet(dateObj),
      dateObj,
      fakturs: [], // tidak relevan untuk entri manual (tidak ada daftar faktur individual dari CSV)
      count: unitCount,
      debit: unitCount * 2,
      fakturRange: buildQuickFakturRange(startNum, unitCount, suffix),
      source: 'manual',
    };

    state.parsedDays.push(entry);
    state.parsedDays.sort((a, b) => (a.dateObj?.getTime() || 0) - (b.dateObj?.getTime() || 0));
    renderPreview(state.parsedDays);

    $('#btnUpload').disabled = false;
    $('#btnUpload').classList.remove('hidden');

    toast(`${unitCount} unit ditambahkan ke pratinjau (${entry.fakturRange})`, 'success', 2500);

    // reset form input cepat, siap untuk entri berikutnya, tanggal & suffix dipertahankan
    unitEl.value = '';
    fakturStartEl.value = '';
    previewBox.classList.add('hidden');
    btnAdd.disabled = true;
  });
}

/** Konversi angka bulan (1-12) ke angka romawi, dipakai untuk format kode faktur. */
function toRomanMonth(month) {
  const romans = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
  return romans[month - 1] || 'I';
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
    const csvDays = parseCSV(text);

    // Gabungkan dengan entri manual yang sudah ada di pratinjau (kalau ada),
    // bukan menimpa — supaya input cepat yang sudah ditambahkan PIC tidak hilang
    // saat upload CSV dilakukan sesudahnya. Kalau tanggalnya sama persis,
    // keduanya tetap dipertahankan sebagai baris terpisah (CSV tidak menimpa manual).
    const existingManual = state.parsedDays.filter(d => d.source === 'manual');
    const merged = [...csvDays, ...existingManual];
    merged.sort((a, b) => (a.dateObj?.getTime() || 0) - (b.dateObj?.getTime() || 0));
    state.parsedDays = merged;

    setTimeout(() => {
      $('#swipeFill').style.width = '100%';
      strip.classList.remove('scanning');
      $('#dzTitle').textContent = 'Berhasil dibaca';
      $('#dzSub').textContent = `${csvDays.length} hari terdeteksi · ${csvDays.reduce((s, d) => s + d.count, 0)} faktur`;
      renderPreview(state.parsedDays);
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
        <div class="unit-count">${day.count} unit terjual${day.source === 'manual' ? ' · input cepat' : ''}</div>
      </div>
      <div class="day-debit">-${day.debit}<small>pcs</small></div>
      <button class="preview-row-remove" data-idx="${idx}" aria-label="Hapus baris ini">
        <svg viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    `;
    list.appendChild(row);
  });

  $$('.preview-row-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      state.parsedDays.splice(idx, 1);
      if (!state.parsedDays.length) {
        resetImportPanel();
      } else {
        renderPreview(state.parsedDays);
      }
    });
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
        buildSaldoFormula(rowNum, prevRowNum), // F: Saldo
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
    const manualCount = state.parsedDays.filter(d => d.source === 'manual').length;
    const logDesc = manualCount > 0
      ? `${values.length} hari (${state.parsedDays.reduce((s,d)=>s+d.debit,0)} pcs debit, ${manualCount} input cepat)`
      : `${values.length} hari (${state.parsedDays.reduce((s,d)=>s+d.debit,0)} pcs debit)`;
    logSession('import', logDesc);
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

/* =========================================================================
   BUAT SHEET BULAN BARU (otomatis)
   Menyalin struktur (header, format, rumus) dari sheet paling akhir yang
   ada, mengosongkan baris transaksinya, lalu mengisi saldo awal dari
   saldo akhir sheet sumber — supaya kontinuitas saldo tetap terjaga.
   ========================================================================= */

/**
 * Buka modal "Buat Sheet Bulan Baru" dengan nama yang disarankan sudah terisi.
 * Dipanggil baik dari deteksi otomatis (sheet bulan berjalan belum ada)
 * maupun dari tombol manual di modal Pilih Sheet Bulan.
 */
function openCreateSheetModal(suggestedName) {
  const templateName = state.availableSheets[state.availableSheets.length - 1] || '—';
  $('#createSheetBasedOn').textContent = templateName;
  $('#createSheetNameInput').value = suggestedName || '';
  openModal('#createSheetModal');
}

/**
 * Duplikasi sheet paling akhir (template) jadi sheet baru dengan nama yang
 * diminta: format & rumus ikut tersalin, baris transaksi lama dikosongkan,
 * dan saldo awal baris pertama diisi angka polos dari saldo akhir template.
 */
async function createMonthSheet(newName) {
  const meta = await getSpreadsheetMeta();
  const sheetList = meta.sheets;
  const templateName = state.availableSheets[state.availableSheets.length - 1];
  const templateProps = sheetList.find(s => s.properties.title === templateName)?.properties;
  if (!templateProps) throw new Error('Sheet template untuk disalin tidak ditemukan.');

  const struct = await readSheetStructure(templateName);

  // 1. duplikasi sheet template ke posisi paling akhir dengan nama baru
  await sheetsFetch(`${state.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        duplicateSheet: {
          sourceSheetId: templateProps.sheetId,
          insertSheetIndex: sheetList.length,
          newSheetName: newName,
        }
      }]
    }),
  });

  // 2. kosongkan baris transaksi lama (antara baris saldo-awal & "Saldo Akhir")
  const clearFromRow = struct.headerRow1 + 2;
  const clearToRow = struct.saldoAkhirRow1 ? struct.saldoAkhirRow1 - 1 : struct.lastSaldoRow1;
  if (clearToRow >= clearFromRow) {
    const clearRange = `'${newName}'!B${clearFromRow}:F${clearToRow}`;
    await sheetsFetch(`${state.spreadsheetId}/values/${encodeURIComponent(clearRange)}:clear`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  // 3. isi saldo awal baris pertama dengan saldo akhir sheet template (angka polos, bukan rumus)
  const saldoAwalRange = `'${newName}'!F${struct.headerRow1 + 1}`;
  await sheetsFetch(`${state.spreadsheetId}/values/${encodeURIComponent(saldoAwalRange)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ range: saldoAwalRange, values: [[struct.currentSaldo]] }),
  });

  // 4. samakan teks judul "Periode ..." (mis. "SO PGR : Periode JUNI 2026") dengan nama sheet baru,
  //    biar nggak ketinggalan nama bulan template lama pas disalin.
  if (struct.periodeRow1 && struct.periodeCol > -1 && struct.periodeText) {
    // regex longgar: tangkap "periode" + pemisah apapun (spasi/titik dua/campuran),
    // sisanya (nama bulan+tahun lama) diganti nama sheet baru.
    const newPeriodeText = struct.periodeText.replace(/(periode[\s:]*)(.*)$/i, (_, prefix) => prefix + newName);
    if (newPeriodeText !== struct.periodeText) {
      const periodeRange = `'${newName}'!${colLetter(struct.periodeCol)}${struct.periodeRow1}`;
      await sheetsFetch(`${state.spreadsheetId}/values/${encodeURIComponent(periodeRange)}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        body: JSON.stringify({ range: periodeRange, values: [[newPeriodeText]] }),
      });
      toast(`Judul periode ikut diperbarui: "${newPeriodeText}".`, 'success', 3200);
    } else {
      toast(`Teks "Periode" ketemu di ${colLetter(struct.periodeCol)}${struct.periodeRow1} tapi polanya nggak cocok buat diganti otomatis — cek manual ya.`, 'error', 6000);
    }
  } else {
    toast('Teks "Periode" nggak ketemu otomatis di sheet template (mungkin itu text box/gambar, bukan isi cell) — judul periode perlu diedit manual.', 'error', 6000);
  }

  await loadSpreadsheetMeta(); // refresh availableSheets biar sheet baru langsung muncul di daftar
}

async function executeCreateMonthSheet() {
  const name = $('#createSheetNameInput').value.trim();
  if (!name) { toast('Nama sheet tidak boleh kosong.', 'error'); return; }
  if (state.availableSheets.includes(name)) { toast('Sheet dengan nama itu sudah ada.', 'error'); return; }

  const btn = $('#btnCreateSheetConfirm');
  setButtonLoading(btn, true, 'Membuat sheet…');
  try {
    await createMonthSheet(name);
    closeModal('#createSheetModal');
    toast(`Sheet ${name} berhasil dibuat.`, 'success');
    lockSheet(name);
    await loadActiveSheetContext(name);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Gagal membuat sheet baru.', 'error');
  } finally {
    setButtonLoading(btn, false, 'Buat Sheet Sekarang');
  }
}

function setupCreateSheetModal() {
  $('#btnCreateSheetConfirm').addEventListener('click', executeCreateMonthSheet);

  const dismiss = () => {
    state.autoCreatePromptDismissedFor = $('#createSheetNameInput').value.trim() || null;
    closeModal('#createSheetModal');
  };
  $('#btnCreateSheetCancel').addEventListener('click', dismiss);
  $('#createSheetModal').addEventListener('click', (e) => { if (e.target.id === 'createSheetModal') dismiss(); });

  $('#btnOpenCreateSheet').addEventListener('click', () => {
    closeModal('#sheetPickerModal');
    openCreateSheetModal(currentMonthSheetName());
  });
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

  const unitEl = $('#quickUnitCount');
  const fakturStartEl = $('#quickFakturStart');
  if (unitEl) unitEl.value = '';
  if (fakturStartEl) fakturStartEl.value = '';
  const quickBox = $('#quickPreviewBox');
  if (quickBox) quickBox.classList.add('hidden');
  const btnAdd = $('#btnQuickAdd');
  if (btnAdd) btnAdd.disabled = true;
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

  $('#manualDate').value = todayLocalISO();

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
      buildSaldoFormula(rowNum, prevRowNum),
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
  if (state.sessionLog.length > SESSION_LOG_MAX_ENTRIES) {
    state.sessionLog.length = SESSION_LOG_MAX_ENTRIES;
  }
  saveSessionLog();
  renderSessionLog();
}

function saveSessionLog() {
  try {
    // Date tidak bisa di-JSON.stringify langsung sebagai Date lagi, jadi disimpan sebagai ISO string
    const serializable = state.sessionLog.map(item => ({ ...item, time: item.time.toISOString() }));
    localStorage.setItem(STORAGE_KEYS.sessionLog, JSON.stringify(serializable));
  } catch (e) {
    console.error('Gagal menyimpan riwayat sesi:', e);
  }
}

function loadSessionLog() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sessionLog);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.sessionLog = parsed.map(item => ({ ...item, time: new Date(item.time) }));
  } catch (e) {
    console.error('Gagal memuat riwayat sesi:', e);
    state.sessionLog = [];
  }
}

function clearSessionLog() {
  state.sessionLog = [];
  localStorage.removeItem(STORAGE_KEYS.sessionLog);
  renderSessionLog();
  toast('Riwayat berhasil dihapus.', 'success');
}

function renderSessionLog() {
  const emptyHTML = `
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="none"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <p>Belum ada input yang tercatat.</p>
    </div>`;

  const bulanSingkat = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const listHTML = state.sessionLog.length
    ? state.sessionLog.map(item => `
      <div class="day-row" style="margin-bottom:8px;">
        <div class="day-date">
          <b>${item.time.getHours().toString().padStart(2,'0')}:${item.time.getMinutes().toString().padStart(2,'0')}</b>
          <span>${item.time.getDate()} ${bulanSingkat[item.time.getMonth()]}</span>
        </div>
        <div class="day-info">
          <div class="faktur-range">${item.desc}</div>
          <div class="unit-count">${item.type === 'import' ? 'Cek Fisik Keluar' : 'Cek Fisik Masuk'}</div>
        </div>
      </div>
    `).join('')
    : emptyHTML;

  const riwayatList = $('#riwayatList');
  if (riwayatList) riwayatList.innerHTML = listHTML;

  const btnClear = $('#btnClearHistory');
  if (btnClear) btnClear.classList.toggle('hidden', state.sessionLog.length === 0);
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

  $('#btnClearHistory').addEventListener('click', () => {
    if (!state.sessionLog.length) { toast('Riwayat sudah kosong.', 'success', 1800); return; }
    if (confirm('Hapus semua riwayat yang tersimpan di perangkat ini? Tindakan ini tidak bisa dibatalkan.')) {
      clearSessionLog();
    }
  });

  setupSheetIdAutoclean();

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

  $('#sheetPickerModal').addEventListener('click', (e) => {
    if (e.target.id === 'sheetPickerModal') closeModal('#sheetPickerModal');
  });
}

/**
 * Kalau user paste link Google Sheets penuh (atau drag-drop / autofill dari browser),
 * field otomatis dirapikan jadi ID-nya doang, biar nggak perlu strip manual.
 */
function setupSheetIdAutoclean() {
  const input = $('#setupSheetId');
  const clean = () => {
    const raw = input.value.trim();
    if (!raw) return;
    const looksLikeUrl = raw.includes('docs.google.com') || raw.includes('/d/');
    if (!looksLikeUrl) return;
    const id = extractSheetIdFromInput(raw);
    if (id && id !== raw) {
      input.value = id;
      toast('Link dirapikan jadi ID spreadsheet.', 'success', 2200);
    }
  };
  input.addEventListener('paste', () => setTimeout(clean, 0));
  input.addEventListener('blur', clean);
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
const NAV_PAGE_IDS = { home: 'pageHome', riwayat: 'pageRiwayat', akun: 'pageAkun' };

function setNavActive(navKey) {
  const idx = NAV_ORDER.indexOf(navKey);
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === navKey));
  const indicator = $('#bnIndicator');
  if (indicator) indicator.className = `bn-indicator pos-${idx < 0 ? 0 : idx}`;
}

/**
 * Ganti page yang tampil (Beranda/Riwayat/Akun). Menggantikan pola modal
 * bottom-sheet yang muncul dari bawah — sekarang murni tukar konten di
 * tempat, kayak berpindah halaman biasa, jadi lebih instan & stabil.
 */
function setActivePage(navKey) {
  Object.entries(NAV_PAGE_IDS).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', key === navKey);
  });
  $('.scroll').scrollTo({ top: 0, behavior: 'auto' });
}

function setupBottomNav() {
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      setNavActive(nav);
      setActivePage(nav);
      if (nav === 'riwayat') {
        renderSessionLog();
      } else if (nav === 'akun') {
        renderAkunPage();
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
  setupImportSubTabs();
  setupQuickEntry();
  setupManualForm();
  setupModals();
  setupCreateSheetModal();
  setupAkunPage();
  setupModalDrag();
  setupTabs();
  setupBottomNav();
  setupThemeToggle();
  setupImportSheetSelect();

  const monthPill = $('#monthPill');
  if (monthPill) monthPill.addEventListener('click', openSheetPicker);

  $('#btnUpload').addEventListener('click', confirmAndUploadImport);

  updateManualFakturPlaceholder();
  loadSessionLog();
  renderSessionLog();
  initGoogleAuth();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
