/**
 * The parts catalog and the proven builds. Prices here are typical street prices in US dollars, written down by
 * hand: they are a starting point, not live. An assistant that looks a price up records it on the build with the
 * store and link it saw it at, and Armable shows that one instead, with its date.
 */

export type Category = 'frame' | 'motors' | 'stack' | 'props' | 'battery' | 'receiver' | 'vtx' | 'camera' | 'antenna' | 'gps' | 'radio' | 'goggles' | 'charger' | 'other';
export type Video = 'analog' | 'dji' | 'walksnail' | 'hdzero';
export type Link = 'ELRS 2.4' | 'ELRS 900' | 'Crossfire';
export type Mount = '30.5' | '25.5' | '20' | 'whoop';

export interface Specs {
  /** Frame: the largest prop it takes. Props: their size. Motors: the prop size they are made for. In inches. */
  propIn?: number;
  /** Frame: the stack mounts it has. Stack: its own mount. */
  mounts?: Mount[];
  stator?: string; kv?: number;
  /** Motors and stacks: the battery cell counts they accept. */
  cells?: [number, number];
  /** Motors: rough peak thrust of one motor on its prop and top cell count, in grams. */
  thrustG?: number;
  /** Motors: peak current of one motor. Stacks: continuous current per motor. */
  amps?: number;
  /** Battery. */
  series?: number; mah?: number; chem?: 'LiPo' | 'LiHV' | 'Li-ion';
  link?: Link;
  video?: Video;
  includes?: ('camera' | 'antenna' | 'receiver')[];
  /** For drawing: prop blades, ducted frames, two-antenna receivers. */
  blades?: number; ducted?: boolean; diversity?: boolean;
}

export interface Part {
  id: string; category: Category; brand: string; name: string;
  /** Typical street price for one unit (one motor, one pack of props, one battery). */
  priceUsd: number;
  /** One unit. For props: one set of four. */
  weightG?: number;
  /** How many a build normally buys. */
  qty?: number;
  specs: Specs;
  /** One line on what it is good for. */
  blurb: string;
  /** The maker's own page, where known. */
  maker?: string;
}

export interface Store { id: string; name: string; search(query: string): string }
const q = encodeURIComponent;
export const STORES: Store[] = [
  { id: 'getfpv', name: 'GetFPV', search: s => `https://www.getfpv.com/catalogsearch/result/?q=${q(s)}` },
  { id: 'rdq', name: 'RaceDayQuads', search: s => `https://www.racedayquads.com/search?q=${q(s)}` },
  { id: 'pyrodrone', name: 'Pyrodrone', search: s => `https://pyrodrone.com/search?q=${q(s)}` },
  { id: 'amazon', name: 'Amazon', search: s => `https://www.amazon.com/s?k=${q(s)}` },
];
/** Where to buy a part: a search at each store, so the link keeps working when a listing moves. */
export const storeLinks = (part: Pick<Part, 'brand' | 'name'>) => STORES.map(s => ({ store: s.name, url: s.search(`${part.brand} ${part.name}`) }));

const P = (p: Part) => p;
export const PARTS: Part[] = [
  // Frames
  P({ id: 'frame.source-one-v5', category: 'frame', brand: 'TBS', name: 'Source One V5 5"', priceUsd: 35, weightG: 115, specs: { propIn: 5.1, mounts: ['30.5', '20'] }, blurb: 'Open-source 5" freestyle frame. Cheap, tough, spare arms everywhere.', maker: 'https://www.team-blacksheep.com' }),
  P({ id: 'frame.apex-5', category: 'frame', brand: 'ImpulseRC', name: 'Apex 5"', priceUsd: 100, weightG: 125, specs: { propIn: 5.1, mounts: ['30.5', '20'] }, blurb: 'Premium 5" freestyle frame with room for a digital air unit.', maker: 'https://impulserc.com' }),
  P({ id: 'frame.chimera7-pro', category: 'frame', brand: 'iFlight', name: 'Chimera7 Pro V2 7"', priceUsd: 95, weightG: 190, specs: { propIn: 7.5, mounts: ['30.5', '20'] }, blurb: '7" long-range frame with a GPS mount and room for a big Li-ion pack.', maker: 'https://shop.iflight.com' }),
  P({ id: 'frame.cinelog35-v2', category: 'frame', brand: 'GEPRC', name: 'CineLog35 V2 frame', priceUsd: 55, weightG: 85, specs: { propIn: 3.5, mounts: ['20', '25.5'], ducted: true }, blurb: '3.5" ducted cinewhoop frame. Safe around people, carries an action camera.', maker: 'https://geprc.com' }),
  P({ id: 'frame.meteor75-pro', category: 'frame', brand: 'BetaFPV', name: 'Meteor75 Pro frame', priceUsd: 10, weightG: 7, specs: { propIn: 1.6, mounts: ['whoop'], ducted: true }, blurb: '75 mm tiny whoop frame for flying indoors.', maker: 'https://betafpv.com' }),
  P({ id: 'frame.pavo25-v2', category: 'frame', brand: 'BetaFPV', name: 'Pavo25 V2 frame', priceUsd: 25, weightG: 35, specs: { propIn: 2.5, mounts: ['25.5', '20'], ducted: true }, blurb: '2.5" ducted frame for a sub-250 g digital cinewhoop.', maker: 'https://betafpv.com' }),
  // Motors (price and weight per motor)
  P({ id: 'motor.velox-v2207-1950', category: 'motors', brand: 'T-Motor', name: 'Velox V2207.5 V2 1950KV', priceUsd: 20, weightG: 33, qty: 4, specs: { propIn: 5, stator: '2207', kv: 1950, cells: [4, 6], thrustG: 1600, amps: 45 }, blurb: 'Smooth, durable 6S 5" freestyle motor.', maker: 'https://store.tmotor.com' }),
  P({ id: 'motor.xing2-2207-1855', category: 'motors', brand: 'iFlight', name: 'XING2 2207 1855KV', priceUsd: 18, weightG: 32, qty: 4, specs: { propIn: 5, stator: '2207', kv: 1855, cells: [4, 6], thrustG: 1550, amps: 44 }, blurb: 'Popular 6S 5" motor with a unibell.', maker: 'https://shop.iflight.com' }),
  P({ id: 'motor.eco2-2207-1900', category: 'motors', brand: 'Emax', name: 'ECO II 2207 1900KV', priceUsd: 12, weightG: 33, qty: 4, specs: { propIn: 5, stator: '2207', kv: 1900, cells: [4, 6], thrustG: 1450, amps: 42 }, blurb: 'Budget 5" motor. Fine to learn on.', maker: 'https://emax-usa.com' }),
  P({ id: 'motor.eco2-2207-2400', category: 'motors', brand: 'Emax', name: 'ECO II 2207 2400KV', priceUsd: 12, weightG: 33, qty: 4, specs: { propIn: 5, stator: '2207', kv: 2400, cells: [3, 4], thrustG: 1350, amps: 45 }, blurb: 'Budget 4S 5" motor.', maker: 'https://emax-usa.com' }),
  P({ id: 'motor.avenger-2806-1300', category: 'motors', brand: 'BrotherHobby', name: 'Avenger 2806.5 1300KV', priceUsd: 28, weightG: 52, qty: 4, specs: { propIn: 7, stator: '2806', kv: 1300, cells: [6, 6], thrustG: 2200, amps: 40 }, blurb: 'Efficient 7" long-range motor for 6S.' }),
  P({ id: 'motor.speedx2-1505-3600', category: 'motors', brand: 'GEPRC', name: 'SPEEDX2 1505 3600KV', priceUsd: 16, weightG: 16, qty: 4, specs: { propIn: 3.5, stator: '1505', kv: 3600, cells: [3, 4], thrustG: 720, amps: 25 }, blurb: '4S motor for 3.5" ducted cinewhoops.', maker: 'https://geprc.com' }),
  P({ id: 'motor.1404-4600', category: 'motors', brand: 'iFlight', name: 'XING 1404 4600KV', priceUsd: 14, weightG: 10, qty: 4, specs: { propIn: 2.5, stator: '1404', kv: 4600, cells: [3, 4], thrustG: 420, amps: 18 }, blurb: '2.5"–3" motor for light 4S builds.', maker: 'https://shop.iflight.com' }),
  P({ id: 'motor.0802se-19500', category: 'motors', brand: 'BetaFPV', name: '0802SE 19500KV', priceUsd: 8, weightG: 2.6, qty: 4, specs: { propIn: 1.6, stator: '0802', kv: 19500, cells: [1, 1], thrustG: 40, amps: 4 }, blurb: '1S whoop motor.', maker: 'https://betafpv.com' }),
  // Flight controller and ESC
  P({ id: 'stack.speedybee-f405-v4', category: 'stack', brand: 'SpeedyBee', name: 'F405 V4 55A stack', priceUsd: 85, weightG: 24, specs: { mounts: ['30.5'], cells: [3, 6], amps: 55 }, blurb: '30×30 flight controller and 4-in-1 ESC with Bluetooth setup from a phone.', maker: 'https://www.speedybee.com' }),
  P({ id: 'stack.speedybee-f405-mini', category: 'stack', brand: 'SpeedyBee', name: 'F405 Mini 35A stack', priceUsd: 60, weightG: 15, specs: { mounts: ['20'], cells: [3, 6], amps: 35 }, blurb: '20×20 stack for 3"–5" builds.', maker: 'https://www.speedybee.com' }),
  P({ id: 'stack.tmotor-f7-pacer-55', category: 'stack', brand: 'T-Motor', name: 'Pacer F7 + 55A stack', priceUsd: 110, weightG: 26, specs: { mounts: ['30.5'], cells: [3, 6], amps: 55 }, blurb: 'F7 30×30 stack with headroom for hard freestyle.', maker: 'https://store.tmotor.com' }),
  P({ id: 'stack.betafpv-f4-1s-aio', category: 'stack', brand: 'BetaFPV', name: 'F4 1S 5A AIO (ELRS)', priceUsd: 40, weightG: 3.5, specs: { mounts: ['whoop'], cells: [1, 1], amps: 5, includes: ['receiver'], link: 'ELRS 2.4' }, blurb: 'Whoop flight controller with the ESC and an ExpressLRS receiver on one board.', maker: 'https://betafpv.com' }),
  // Props (one pack = one set of four)
  P({ id: 'props.ethix-s5', category: 'props', brand: 'HQProp', name: 'Ethix S5 5x4x3', priceUsd: 4, weightG: 17, qty: 3, specs: { propIn: 5, blades: 3 }, blurb: 'Smooth freestyle prop.', maker: 'https://www.hqprop.com' }),
  P({ id: 'props.hurricane-51466', category: 'props', brand: 'Gemfan', name: 'Hurricane 51466', priceUsd: 4, weightG: 17, qty: 3, specs: { propIn: 5.1, blades: 3 }, blurb: 'Grippy, durable 5.1" prop.', maker: 'https://www.gemfanhobby.com' }),
  P({ id: 'props.hq-7x4x3', category: 'props', brand: 'HQProp', name: '7x4x3 Durable', priceUsd: 6, weightG: 32, qty: 2, specs: { propIn: 7, blades: 3 }, blurb: 'Efficient 7" long-range prop.', maker: 'https://www.hqprop.com' }),
  P({ id: 'props.d90-5', category: 'props', brand: 'Gemfan', name: 'D90-5 3.5" ducted', priceUsd: 5, weightG: 10, qty: 3, specs: { propIn: 3.5, blades: 5 }, blurb: 'Five-blade prop for 3.5" ducts.', maker: 'https://www.gemfanhobby.com' }),
  P({ id: 'props.d63-5', category: 'props', brand: 'Gemfan', name: 'D63-5 2.5" ducted', priceUsd: 4, weightG: 5, qty: 3, specs: { propIn: 2.5, blades: 5 }, blurb: 'Five-blade prop for 2.5" ducts.', maker: 'https://www.gemfanhobby.com' }),
  P({ id: 'props.1610-3', category: 'props', brand: 'Gemfan', name: '1610 40 mm 3-blade', priceUsd: 3, weightG: 1, qty: 4, specs: { propIn: 1.6, blades: 3 }, blurb: 'Whoop prop for 0802 motors.', maker: 'https://www.gemfanhobby.com' }),
  // Batteries
  P({ id: 'battery.rline-6s-1300', category: 'battery', brand: 'Tattu', name: 'R-Line 6S 1300mAh', priceUsd: 40, weightG: 210, qty: 4, specs: { series: 6, mah: 1300, chem: 'LiPo' }, blurb: 'Hard-hitting 6S pack for 5" freestyle.', maker: 'https://genstattu.com' }),
  P({ id: 'battery.cnhl-6s-1100', category: 'battery', brand: 'CNHL', name: 'Black Series 6S 1100mAh', priceUsd: 28, weightG: 185, qty: 4, specs: { series: 6, mah: 1100, chem: 'LiPo' }, blurb: 'Budget 6S freestyle pack.', maker: 'https://chinahobbyline.com' }),
  P({ id: 'battery.cnhl-4s-1500', category: 'battery', brand: 'CNHL', name: 'Black Series 4S 1500mAh', priceUsd: 25, weightG: 175, qty: 4, specs: { series: 4, mah: 1500, chem: 'LiPo' }, blurb: 'Budget 4S pack for 5" on 4S motors.', maker: 'https://chinahobbyline.com' }),
  P({ id: 'battery.rline-4s-850', category: 'battery', brand: 'Tattu', name: 'R-Line 4S 850mAh', priceUsd: 25, weightG: 105, qty: 4, specs: { series: 4, mah: 850, chem: 'LiPo' }, blurb: 'Light 4S pack for 3"–3.5" builds.', maker: 'https://genstattu.com' }),
  P({ id: 'battery.p45b-6s1p', category: 'battery', brand: 'Molicel', name: 'P45B 6S1P 4500mAh Li-ion', priceUsd: 70, weightG: 440, qty: 2, specs: { series: 6, mah: 4500, chem: 'Li-ion' }, blurb: 'Long-range Li-ion pack: 20 minutes and more of cruising on a 7".' }),
  P({ id: 'battery.bt2-1s-300', category: 'battery', brand: 'BetaFPV', name: 'BT2.0 1S 300mAh', priceUsd: 4, weightG: 8, qty: 6, specs: { series: 1, mah: 300, chem: 'LiHV' }, blurb: 'Whoop pack. Buy a handful.', maker: 'https://betafpv.com' }),
  // Receivers
  P({ id: 'rx.rp1-v2', category: 'receiver', brand: 'RadioMaster', name: 'RP1 V2 ExpressLRS 2.4GHz', priceUsd: 16, weightG: 1, specs: { link: 'ELRS 2.4' }, blurb: 'Tiny ExpressLRS receiver for any freestyle build.', maker: 'https://radiomasterrc.com' }),
  P({ id: 'rx.rp4td', category: 'receiver', brand: 'RadioMaster', name: 'RP4TD ExpressLRS 2.4GHz true diversity', priceUsd: 25, weightG: 3, specs: { link: 'ELRS 2.4', diversity: true }, blurb: 'Two radios, two antennas: the most robust 2.4 GHz link for long range.', maker: 'https://radiomasterrc.com' }),
  P({ id: 'rx.betafpv-elrs-900', category: 'receiver', brand: 'BetaFPV', name: 'ELRS Nano 900MHz', priceUsd: 17, weightG: 1.5, specs: { link: 'ELRS 900' }, blurb: '900 MHz ExpressLRS for penetration and range.', maker: 'https://betafpv.com' }),
  P({ id: 'rx.crossfire-nano', category: 'receiver', brand: 'TBS', name: 'Crossfire Nano RX', priceUsd: 30, weightG: 1, specs: { link: 'Crossfire' }, blurb: 'Crossfire 868/915 MHz receiver.', maker: 'https://www.team-blacksheep.com' }),
  // Video
  P({ id: 'vtx.dji-o4-pro', category: 'vtx', brand: 'DJI', name: 'O4 Air Unit Pro', priceUsd: 199, weightG: 32, specs: { video: 'dji', includes: ['camera', 'antenna'] }, blurb: 'DJI digital video with a 4K camera that records on board.', maker: 'https://store.dji.com' }),
  P({ id: 'vtx.dji-o4', category: 'vtx', brand: 'DJI', name: 'O4 Air Unit', priceUsd: 99, weightG: 9, specs: { video: 'dji', includes: ['camera', 'antenna'] }, blurb: 'Light DJI digital unit for small and sub-250 g builds.', maker: 'https://store.dji.com' }),
  P({ id: 'vtx.walksnail-v2', category: 'vtx', brand: 'Walksnail', name: 'Avatar HD V2 kit', priceUsd: 150, weightG: 28, specs: { video: 'walksnail', includes: ['camera', 'antenna'] }, blurb: 'Walksnail digital video: camera, transmitter and antennas.', maker: 'https://caddxfpv.com' }),
  P({ id: 'vtx.rush-tank-ultimate', category: 'vtx', brand: 'RushFPV', name: 'Tank Ultimate Mini analog VTX', priceUsd: 35, weightG: 6, specs: { video: 'analog' }, blurb: 'Analog 5.8 GHz transmitter up to 800 mW.' }),
  P({ id: 'vtx.betafpv-m04', category: 'vtx', brand: 'BetaFPV', name: 'M04 25–400mW analog VTX', priceUsd: 20, weightG: 1.6, specs: { video: 'analog', includes: ['antenna'] }, blurb: 'Whoop analog transmitter with its own antenna.', maker: 'https://betafpv.com' }),
  // Cameras (analog)
  P({ id: 'cam.ratel2', category: 'camera', brand: 'Caddx', name: 'Ratel 2 V2', priceUsd: 30, weightG: 6, specs: { video: 'analog' }, blurb: 'Clear analog camera with good low light.', maker: 'https://caddxfpv.com' }),
  P({ id: 'cam.phoenix2-sp', category: 'camera', brand: 'RunCam', name: 'Phoenix 2 SP V3', priceUsd: 30, weightG: 8, specs: { video: 'analog' }, blurb: 'Analog freestyle camera with natural colour.', maker: 'https://www.runcam.com' }),
  P({ id: 'cam.ant-lite', category: 'camera', brand: 'Caddx', name: 'Ant Lite 1200TVL', priceUsd: 15, weightG: 2, specs: { video: 'analog' }, blurb: 'Tiny analog camera for whoops.', maker: 'https://caddxfpv.com' }),
  // Antennas
  P({ id: 'ant.axii2-stubby', category: 'antenna', brand: 'Lumenier', name: 'AXII 2 Stubby 5.8GHz', priceUsd: 13, weightG: 3, specs: {}, blurb: 'Compact, clean analog video antenna.', maker: 'https://www.lumenier.com' }),
  P({ id: 'ant.foxeer-lollipop4', category: 'antenna', brand: 'Foxeer', name: 'Lollipop 4 5.8GHz', priceUsd: 10, weightG: 4, specs: {}, blurb: 'Durable video antenna.', maker: 'https://www.foxeer.com' }),
  // GPS
  P({ id: 'gps.m10q', category: 'gps', brand: 'Foxeer', name: 'M10Q-180 GPS', priceUsd: 20, weightG: 5, specs: {}, blurb: 'Small M10 GPS for rescue mode and position on screen.', maker: 'https://www.foxeer.com' }),
  P({ id: 'gps.m100-5883', category: 'gps', brand: 'HGLRC', name: 'M100-5883 GPS with compass', priceUsd: 23, weightG: 9, specs: {}, blurb: 'GPS with a compass for INAV and ArduPilot navigation.', maker: 'https://www.hglrc.com' }),
  // What you need to fly it
  P({ id: 'radio.pocket-elrs', category: 'radio', brand: 'RadioMaster', name: 'Pocket ELRS', priceUsd: 70, specs: { link: 'ELRS 2.4' }, blurb: 'Small, cheap first radio with ExpressLRS built in.', maker: 'https://radiomasterrc.com' }),
  P({ id: 'radio.boxer-elrs', category: 'radio', brand: 'RadioMaster', name: 'Boxer ELRS', priceUsd: 140, specs: { link: 'ELRS 2.4' }, blurb: 'Full-size gimbals and a 1 W ExpressLRS module.', maker: 'https://radiomasterrc.com' }),
  P({ id: 'radio.tango2', category: 'radio', brand: 'TBS', name: 'Tango 2 Crossfire', priceUsd: 160, specs: { link: 'Crossfire' }, blurb: 'Compact Crossfire radio.', maker: 'https://www.team-blacksheep.com' }),
  P({ id: 'goggles.dji-n3', category: 'goggles', brand: 'DJI', name: 'Goggles N3', priceUsd: 229, specs: { video: 'dji' }, blurb: 'Affordable DJI goggles for O4 air units.', maker: 'https://store.dji.com' }),
  P({ id: 'goggles.dji-3', category: 'goggles', brand: 'DJI', name: 'Goggles 3', priceUsd: 499, specs: { video: 'dji' }, blurb: 'DJI micro-OLED goggles with head tracking.', maker: 'https://store.dji.com' }),
  P({ id: 'goggles.walksnail-l', category: 'goggles', brand: 'Walksnail', name: 'Avatar HD Goggles L', priceUsd: 279, specs: { video: 'walksnail' }, blurb: 'Walksnail goggles.', maker: 'https://caddxfpv.com' }),
  P({ id: 'goggles.cobra-x', category: 'goggles', brand: 'Skyzone', name: 'Cobra X V4 analog', priceUsd: 219, specs: { video: 'analog' }, blurb: 'Analog box goggles with a receiver module built in.', maker: 'https://www.skyzonefpv.com' }),
  P({ id: 'goggles.ev800d', category: 'goggles', brand: 'Eachine', name: 'EV800D analog', priceUsd: 100, specs: { video: 'analog' }, blurb: 'Cheap analog box goggles to start on.' }),
  P({ id: 'charger.m7ac', category: 'charger', brand: 'ToolkitRC', name: 'M7AC', priceUsd: 79, specs: {}, blurb: 'AC/DC charger for 1S–6S packs.', maker: 'https://www.toolkitrc.com' }),
  // Extras: nice to have, on the aircraft or on the bench. Weight counts only for parts that fly.
  P({ id: 'extra.vifly-finder-mini', category: 'other', brand: 'ViFly', name: 'Finder Mini lost-model buzzer', priceUsd: 15, weightG: 4, specs: {}, blurb: 'Beeps for hours after a crash, even with the battery thrown, so you find it in long grass.' }),
  P({ id: 'extra.straps', category: 'other', brand: 'Generic', name: 'Kevlar battery straps, 5 pack', priceUsd: 8, weightG: 6, specs: {}, blurb: 'Straps wear out. Keep spares.' }),
  P({ id: 'extra.gopro-13', category: 'other', brand: 'GoPro', name: 'HERO13 Black', priceUsd: 399, weightG: 154, specs: {}, blurb: 'Stabilised action camera for clean footage from an analog quad.', maker: 'https://gopro.com' }),
  P({ id: 'extra.shortsaver', category: 'other', brand: 'ViFly', name: 'ShortSaver 2 smoke stopper', priceUsd: 20, specs: {}, blurb: 'Plug in before the first battery: it cuts power on a short instead of letting the magic smoke out.' }),
  P({ id: 'extra.pinecil', category: 'other', brand: 'Pine64', name: 'Pinecil V2 soldering iron', priceUsd: 26, specs: {}, blurb: 'Small, hot and cheap. Enough for every joint on a quad.', maker: 'https://pine64.com' }),
  P({ id: 'extra.lipo-bag', category: 'other', brand: 'Generic', name: 'LiPo safe charging bag', priceUsd: 12, specs: {}, blurb: 'Charge and store packs in it.' }),
  P({ id: 'extra.xt60-pigtails', category: 'other', brand: 'Generic', name: 'XT60 pigtails, 5 pack', priceUsd: 7, specs: {}, blurb: 'Spare battery leads for when one gets ripped off.' }),
  P({ id: 'charger.bt2-6port', category: 'charger', brand: 'BetaFPV', name: 'BT2.0 1S six-port charger', priceUsd: 20, specs: {}, blurb: 'Charges six whoop packs at once.', maker: 'https://betafpv.com' }),
];
export const PART_BY_ID = new Map(PARTS.map(p => [p.id, p]));

/** A recipe that pilots have flown many times. Every part is in the catalog, so it can be priced and changed. */
export interface Proven { id: string; name: string; style: string; summary: string; propIn: number; video: Video; parts: string[]; why: string }
export const PROVEN: Proven[] = [
  { id: 'proven.5in-analog-starter', name: '5" analog freestyle starter', style: 'freestyle', propIn: 5, video: 'analog', summary: 'The cheapest way into real freestyle. Analog video, 6S, ExpressLRS.',
    why: 'An open-source frame with cheap spares, budget motors that survive crashes, and analog video so goggles cost less.',
    parts: ['frame.source-one-v5', 'motor.eco2-2207-1900', 'stack.speedybee-f405-v4', 'props.ethix-s5', 'battery.cnhl-6s-1100', 'rx.rp1-v2', 'vtx.rush-tank-ultimate', 'cam.ratel2', 'ant.axii2-stubby'] },
  { id: 'proven.5in-dji-freestyle', name: '5" DJI O4 Pro freestyle', style: 'freestyle', propIn: 5, video: 'dji', summary: 'Premium 6S freestyle with DJI digital video and 4K recording on board.',
    why: 'Smooth motors and a stiff frame give clean footage; the O4 Pro records stabilised 4K, so no action camera is needed.',
    parts: ['frame.apex-5', 'motor.velox-v2207-1950', 'stack.speedybee-f405-v4', 'props.ethix-s5', 'battery.rline-6s-1300', 'rx.rp1-v2', 'vtx.dji-o4-pro'] },
  { id: 'proven.7in-long-range', name: '7" long range', style: 'long-range', propIn: 7, video: 'dji', summary: 'Mountain surfing and long cruises: 6S Li-ion, GPS rescue, a diversity receiver.',
    why: 'Low-KV motors on 7" props are efficient; a Li-ion pack roughly triples flight time; GPS brings it home if the link drops.',
    parts: ['frame.chimera7-pro', 'motor.avenger-2806-1300', 'stack.speedybee-f405-v4', 'props.hq-7x4x3', 'battery.p45b-6s1p', 'rx.rp4td', 'vtx.dji-o4-pro', 'gps.m10q'] },
  { id: 'proven.35-cinewhoop', name: '3.5" cinewhoop', style: 'cinematic', propIn: 3.5, video: 'dji', summary: 'Ducted and safe near people, for smooth indoor and close-proximity shots.',
    why: 'Ducts protect props and people; 4S keeps it light; the O4 Pro records the footage.',
    parts: ['frame.cinelog35-v2', 'motor.speedx2-1505-3600', 'stack.speedybee-f405-mini', 'props.d90-5', 'battery.rline-4s-850', 'rx.rp1-v2', 'vtx.dji-o4-pro'] },
  { id: 'proven.25-sub250', name: '2.5" sub-250 g digital', style: 'cinematic', propIn: 2.5, video: 'dji', summary: 'Under 250 g with a battery: a small digital whoop you can take anywhere.',
    why: 'A light ducted frame and the 9 g O4 Air Unit keep the take-off weight under 250 g in most places that set that limit.',
    parts: ['frame.pavo25-v2', 'motor.1404-4600', 'stack.speedybee-f405-mini', 'props.d63-5', 'battery.rline-4s-850', 'rx.rp1-v2', 'vtx.dji-o4'] },
  { id: 'proven.75-whoop', name: '75 mm tiny whoop', style: 'whoop', propIn: 1.6, video: 'analog', summary: 'Indoor practice in the living room: 1S, analog, and batteries that cost a few dollars.',
    why: 'The best way to learn: it bounces off walls, batteries cost a few dollars, and practice transfers to bigger quads.',
    parts: ['frame.meteor75-pro', 'motor.0802se-19500', 'stack.betafpv-f4-1s-aio', 'props.1610-3', 'battery.bt2-1s-300', 'vtx.betafpv-m04', 'cam.ant-lite', 'charger.bt2-6port'] },
];
export const PROVEN_BY_ID = new Map(PROVEN.map(p => [p.id, p]));
