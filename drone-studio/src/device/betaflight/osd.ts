import { DeviceError } from '../bytes';
import type { Setting } from '../types';

/**
 * Betaflight OSD element positions (osd.h): x in bits 0-4 plus bit 10 for HD widths, y in bits 5-9,
 * visibility per OSD profile in bits 11-13, and display style in bits 14-15.
 */
export interface OsdPosition { x: number; y: number; profiles: number; type: number }
export function decodeOsd(v: number): OsdPosition {
  return { x: (v & 0x1f) | ((v & 0x400) >> 5), y: (v >> 5) & 0x1f, profiles: (v >> 11) & 0x7, type: (v >> 14) & 0x3 };
}
export function encodeOsd(p: OsdPosition): number {
  if (!(p.x >= 0 && p.x <= 63 && p.y >= 0 && p.y <= 31)) throw new DeviceError('invalid', 'OSD positions are x 0 to 63 and y 0 to 31.');
  return ((p.x & 0x1f) | ((p.x << 5) & 0x400) | ((p.y & 0x1f) << 5) | ((p.profiles & 0x7) << 11) | ((p.type & 0x3) << 14)) >>> 0;
}
/** Accepts a raw number, or "x,y" / "x,y,on" / "x,y,off" applied to the current value (keeping its style and other profiles). */
export function parseOsdValue(value: string | number, current: number): number {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new DeviceError('invalid', 'An OSD position number is 0 to 65535.');
    return n;
  }
  const m = String(value).trim().toLowerCase().match(/^(\d{1,2})\s*,\s*(\d{1,2})(?:\s*,\s*(on|off))?$/);
  if (!m) throw new DeviceError('invalid', `"${value}" is not an OSD position.`, 'Use "x,y", "x,y,on" or "x,y,off", for example "1,12,on".');
  const now = decodeOsd(current);
  const profiles = m[3] === 'on' ? now.profiles | 1 : m[3] === 'off' ? now.profiles & ~1 : now.profiles;
  return encodeOsd({ x: Number(m[1]), y: Number(m[2]), profiles, type: now.type });
}
export const OSD_NAMES: Record<string, string> = {
  vbat: 'Battery voltage', avg_cell_voltage: 'Cell voltage', rssi: 'RSSI', link_quality: 'Link quality', rssi_dbm: 'RSSI dBm', tim_1: 'Timer 1', tim_2: 'Timer 2',
  flymode: 'Flight mode', throttle: 'Throttle', vtx_channel: 'Video channel', crosshairs: 'Crosshairs', ah_sbar: 'Horizon sidebars', ah: 'Artificial horizon',
  current: 'Current', mah_drawn: 'mAh used', craft_name: 'Craft name', pilot_name: 'Pilot name', gps_speed: 'GPS speed', gps_sats: 'GPS satellites', gps_lat: 'Latitude', gps_lon: 'Longitude',
  home_dir: 'Home arrow', home_dist: 'Home distance', altitude: 'Altitude', warnings: 'Warnings', disarmed: 'Disarmed', esc_tmp: 'ESC temperature', esc_rpm: 'ESC RPM',
  power: 'Power', compass_bar: 'Compass', flight_dist: 'Flight distance', rtc_date_time: 'Date and time', core_temp: 'Core temperature', pit_ang: 'Pitch angle', rol_ang: 'Roll angle',
  efficiency: 'Efficiency', battery_usage: 'Battery used', log_status: 'Log status', stick_overlay_left: 'Left stick', stick_overlay_right: 'Right stick', g_force: 'G-force',
  remaining_time_estimate: 'Time left', anti_gravity: 'Anti-gravity', pidrate_profile: 'Profiles', profile_name: 'Profile name', motor_diag: 'Motor outputs', wh_drawn: 'Wh used',
};
export interface OsdElement { id: string; key: string; name: string; value: number; pos: OsdPosition; visible: boolean }
export interface OsdLayout { columns: number; rows: number; system: string; elements: OsdElement[] }
/** The screen and every element on it, from the settings the flight controller reported. */
export function osdLayout(settings: Setting[]): OsdLayout | undefined {
  const elements = settings.filter(s => /^bf\.osd_[a-z0-9_]+_pos$/.test(s.id) && typeof s.value === 'number').map(s => {
    const key = s.id.slice(7, -4), pos = decodeOsd(Number(s.value));
    return { id: s.id, key, name: OSD_NAMES[key] ?? key.replace(/_/g, ' '), value: Number(s.value), pos, visible: (pos.profiles & 1) === 1 };
  });
  if (!elements.length) return undefined;
  const system = String(settings.find(s => s.id === 'bf.vcd_video_system')?.value ?? 'PAL').toUpperCase();
  const hd = system === 'HD';
  const cw = Number(settings.find(s => s.id === 'bf.osd_canvas_width')?.value ?? 0), ch = Number(settings.find(s => s.id === 'bf.osd_canvas_height')?.value ?? 0);
  return { columns: hd ? cw || 53 : 30, rows: hd ? ch || 20 : system === 'NTSC' ? 13 : 16, system, elements };
}
