// Windows AppBar (Application Desktop Toolbar) interop via koffi.
// Reserves screen-edge space so maximized / snapped windows never overlap
// FeedMe, exactly like the taskbar.
//
// This module ONLY reserves space (ABM_SETPOS). It never moves the window —
// electron.js positions the window itself in DIP via Electron, on a clean work
// area, then hands us the equivalent PHYSICAL-pixel rect to reserve. (Moving
// the window from here, or letting Electron position it while a reservation is
// active, hits DPI/work-area remapping bugs on scaled multi-monitor setups.)

'use strict';

const koffi = require('koffi');

// --- Win32 constants -------------------------------------------------------
const ABM_NEW = 0x00000000;
const ABM_REMOVE = 0x00000001;
const ABM_SETPOS = 0x00000003;

const ABE_LEFT = 0;
const ABE_RIGHT = 2;

// WM_USER + 1 — message Windows would send us for appbar notifications. We
// don't listen (we reflow off Electron's display events instead), but ABM_NEW
// requires a valid message id.
const CALLBACK_MESSAGE = 0x0401;

// --- Struct definitions ----------------------------------------------------
const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
});

// typedef struct { DWORD cbSize; HWND hWnd; UINT uCallbackMessage; UINT uEdge;
//                  RECT rc; LPARAM lParam; } APPBARDATA;
const APPBARDATA = koffi.struct('APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'uintptr_t',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: RECT,
  lParam: 'intptr_t',
});

const SIZEOF_APPBARDATA = koffi.sizeof(APPBARDATA);

// UINT_PTR SHAppBarMessage(DWORD dwMessage, PAPPBARDATA pData);
const shell32 = koffi.load('shell32.dll');
const SHAppBarMessage = shell32.func(
  '__stdcall',
  'SHAppBarMessage',
  'uintptr_t',
  ['uint32', koffi.inout(koffi.pointer(APPBARDATA))]
);

// --- Helpers ---------------------------------------------------------------

// Electron's getNativeWindowHandle() returns an 8-byte LE buffer (HWND) on x64.
function hwndFromWindow(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function baseData(hwnd) {
  return {
    cbSize: SIZEOF_APPBARDATA,
    hWnd: hwnd,
    uCallbackMessage: CALLBACK_MESSAGE,
    uEdge: ABE_RIGHT,
    rc: { left: 0, top: 0, right: 0, bottom: 0 },
    lParam: 0,
  };
}

// Register the appbar (ABM_NEW). Call once before reserving.
function register(hwnd) {
  return SHAppBarMessage(ABM_NEW, baseData(hwnd)) !== 0n;
}

// Reserve exactly `rect` (physical px) on `edge` via ABM_SETPOS. The caller has
// already positioned the window there using a work-area-derived rect, so the
// band avoids the taskbar and there is nothing to negotiate.
function setPos(hwnd, edge, rect) {
  const data = baseData(hwnd);
  data.uEdge = edge;
  data.rc = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  SHAppBarMessage(ABM_SETPOS, data);
}

// Release the reserved space (ABM_REMOVE). MUST be called before quit, or a
// dead band stays carved out of the desktop until explorer re-polls.
function remove(hwnd) {
  SHAppBarMessage(ABM_REMOVE, baseData(hwnd));
}

module.exports = {
  ABE_LEFT,
  ABE_RIGHT,
  hwndFromWindow,
  register,
  setPos,
  remove,
};
