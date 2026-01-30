import path from 'path';

const EXTENSION_MAP = {
  // NES
  '.nes': { system: 'nes', core: 'fceumm' },
  '.fds': { system: 'nes', core: 'fceumm' },
  '.unf': { system: 'nes', core: 'fceumm' },
  '.unif': { system: 'nes', core: 'fceumm' },
  // SNES
  '.sfc': { system: 'snes', core: 'snes9x' },
  '.smc': { system: 'snes', core: 'snes9x' },
  // GBA
  '.gba': { system: 'gba', core: 'mgba' },
  // Game Boy
  '.gb': { system: 'gb', core: 'gambatte' },
  // Game Boy Color
  '.gbc': { system: 'gbc', core: 'gambatte' },
  // Genesis / Mega Drive
  '.md': { system: 'genesis', core: 'genesis_plus_gx' },
  '.gen': { system: 'genesis', core: 'genesis_plus_gx' },
  '.smd': { system: 'genesis', core: 'genesis_plus_gx' },
  '.bin': { system: 'genesis', core: 'genesis_plus_gx' },
  // Sega Master System
  '.sms': { system: 'sms', core: 'genesis_plus_gx' },
  // Sega Game Gear
  '.gg': { system: 'gg', core: 'genesis_plus_gx' },
  // Sega SG-1000
  '.sg': { system: 'sg1000', core: 'genesis_plus_gx' },
  // Atari 2600
  '.a26': { system: 'atari2600', core: 'stella2014' },
  // Atari 5200
  '.a52': { system: 'atari5200', core: 'atari800' },
  // Atari 8-bit computers (400/800/XL/XE)
  '.xex': { system: 'atari800', core: 'atari800' },
  '.atr': { system: 'atari800', core: 'atari800' },
  '.atx': { system: 'atari800', core: 'atari800' },
  '.bas': { system: 'atari800', core: 'atari800' },
  '.car': { system: 'atari800', core: 'atari800' },
  '.xfd': { system: 'atari800', core: 'atari800' },
  // Atari 7800
  '.a78': { system: 'atari7800', core: 'prosystem' },
  // Atari Lynx
  '.lnx': { system: 'lynx', core: 'handy' },
  '.o': { system: 'lynx', core: 'handy' },
  // TurboGrafx-16 / PC Engine
  '.pce': { system: 'pce', core: 'beetle_pce_fast' },
  '.cue': { system: 'pce', core: 'beetle_pce_fast' },
  '.ccd': { system: 'pce', core: 'beetle_pce_fast' },
  '.chd': { system: 'pce', core: 'beetle_pce_fast' },
  // Neo Geo Pocket / Color
  '.ngp': { system: 'ngp', core: 'mednafen_ngp' },
  '.ngc': { system: 'ngpc', core: 'mednafen_ngp' },
  // WonderSwan / Color
  '.ws': { system: 'wswan', core: 'mednafen_wswan' },
  '.wsc': { system: 'wswanc', core: 'mednafen_wswan' },
  // ColecoVision
  '.col': { system: 'coleco', core: 'gearcoleco' },
  // Vectrex
  '.vec': { system: 'vectrex', core: 'vecx' },
  // ZX Spectrum
  '.tzx': { system: 'spectrum', core: 'fuse' },
  '.z80': { system: 'spectrum', core: 'fuse' },
  '.sna': { system: 'spectrum', core: 'fuse' },
  // MSX / MSX2
  '.mx1': { system: 'msx', core: 'fmsx' },
  '.mx2': { system: 'msx', core: 'fmsx' },
  '.rom': { system: 'msx', core: 'fmsx' },
  '.dsk': { system: 'msx', core: 'fmsx' },
  '.cas': { system: 'msx', core: 'fmsx' },
  // PlayStation 1
  '.iso': { system: 'psx', core: 'pcsx_rearmed' },
  '.pbp': { system: 'psx', core: 'pcsx_rearmed' },
  '.m3u': { system: 'psx', core: 'pcsx_rearmed' },
};

const SYSTEM_NAMES = {
  nes: 'Nintendo Entertainment System',
  snes: 'Super Nintendo',
  gba: 'Game Boy Advance',
  gb: 'Game Boy',
  gbc: 'Game Boy Color',
  genesis: 'Sega Genesis / Mega Drive',
  sms: 'Sega Master System',
  gg: 'Sega Game Gear',
  sg1000: 'Sega SG-1000',
  atari2600: 'Atari 2600',
  atari5200: 'Atari 5200',
  atari7800: 'Atari 7800',
  atari800: 'Atari 800/XL/XE',
  lynx: 'Atari Lynx',
  pce: 'TurboGrafx-16 / PC Engine',
  ngp: 'Neo Geo Pocket',
  ngpc: 'Neo Geo Pocket Color',
  wswan: 'WonderSwan',
  wswanc: 'WonderSwan Color',
  coleco: 'ColecoVision',
  vectrex: 'Vectrex',
  spectrum: 'ZX Spectrum',
  msx: 'MSX / MSX2',
  psx: 'PlayStation',
};

export function detectSystem(romPath) {
  const ext = path.extname(romPath).toLowerCase();
  const entry = EXTENSION_MAP[ext];
  if (!entry) {
    return null;
  }
  return {
    ...entry,
    systemName: SYSTEM_NAMES[entry.system],
    extension: ext,
  };
}

export function getSupportedExtensions() {
  return Object.keys(EXTENSION_MAP);
}

export function getSystemName(systemId) {
  return SYSTEM_NAMES[systemId] || systemId;
}
