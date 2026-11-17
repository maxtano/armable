import type { Stack } from '../device/types';

/**
 * Authored knowledge: what an expert would check for a symptom, and where to read more.
 * Reviewed like code. References are links and Lucidity's own notes; nothing is copied from the sources.
 */
export interface PlaybookStep { do: string; use?: { tool: 'read' | 'run_test' | 'propose_change' | 'find'; arguments: Record<string, unknown> }; why?: string }
export interface Playbook { id: string; symptom: string; words: string[]; stacks?: Stack[]; steps: PlaybookStep[]; caution?: string }
export interface Reference { id: string; title: string; url: string; kind: 'guide' | 'video' | 'tool'; stacks?: Stack[]; words: string[]; part?: string; startSeconds?: number; note?: string }

const AP: Stack[] = ['ardupilot'], BF: Stack[] = ['betaflight', 'inav'], MAV: Stack[] = ['ardupilot', 'px4'];

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'play.motor-wrong-way', symptom: 'A motor spins the wrong way', words: ['motor', 'spin', 'backwards', 'wrong', 'way', 'direction', 'reverse', 'reversed', 'rotation', 'prop'],
    caution: 'Props off for every step.',
    steps: [
      { do: 'See which way each motor should turn.', use: { tool: 'read', arguments: { ids: ['airframe.layout'] } }, why: 'The layout gives the expected spin for every motor number.' },
      { do: 'Spin the suspect motor so the person can watch it.', use: { tool: 'run_test', arguments: { id: 'motor.spin', args: { motor: 1 } } }, why: 'Confirms which physical motor it is and which way it turns. The person starts it.' },
      { do: 'Read the ESCs to see each direction setting.', use: { tool: 'run_test', arguments: { id: 'esc.read' } } },
      { do: 'Flip the direction of the one that is wrong.', use: { tool: 'propose_change', arguments: { changes: [{ id: 'esc.1.direction', value: 'reversed' }] } }, why: 'Use the ESC number that matches the motor, and the opposite of its current value.' },
      { do: 'Spin it again to confirm.', use: { tool: 'run_test', arguments: { id: 'motor.spin', args: { motor: 1 } } } },
      { do: 'If every motor is opposite to the layout, the frame setting is wrong, not the ESCs.', use: { tool: 'find', arguments: { query: 'props out frame type' } } },
    ],
  },
  {
    id: 'play.wont-arm', symptom: 'It will not arm', words: ['arm', 'arming', 'wont', 'not', 'refuses', 'disarmed', 'prearm', 'beeps', 'blocked'],
    steps: [
      { do: 'Ask the flight controller why.', use: { tool: 'run_test', arguments: { id: 'prearm.check' } }, why: 'It lists the exact reasons in its own words.' },
      { do: 'Check the radio is arriving.', use: { tool: 'run_test', arguments: { id: 'radio.check' } }, why: 'No receiver signal is the most common cause.' },
      { do: 'Check sensors and battery.', use: { tool: 'run_test', arguments: { id: 'diagnostics.full' } } },
      { do: 'Look up any block you do not recognise.', use: { tool: 'find', arguments: { query: 'arming checks', kinds: ['reference'] } } },
    ],
  },
  {
    id: 'play.shakes-in-flight', symptom: 'It shakes, wobbles or buzzes in flight', words: ['shake', 'shakes', 'wobble', 'vibration', 'vibrate', 'buzz', 'oscillate', 'oscillation', 'jello', 'shiver', 'hot', 'motors'],
    caution: 'Fix mechanical causes before changing tuning. Lower gains hide a loose part; they do not fix it.',
    steps: [
      { do: 'Analyse the most recent flight log.', use: { tool: 'run_test', arguments: { id: 'logs.analyze' } }, why: 'Shows vibration per axis and how well the aircraft followed its commands.' },
      { do: 'Read the vibration and tracking results.', use: { tool: 'read', arguments: { ids: ['log.latest.vibration', 'log.latest.tracking'] } } },
      { do: 'If vibration is high, ask the person to check props, motor screws, and the flight controller mounting.' },
      { do: 'If vibration is low but tracking error is high, look at the rate gains and filters.', use: { tool: 'find', arguments: { query: 'rate gains filter', kinds: ['setting'] } } },
      { do: 'Change one thing at a time and fly a short test between changes.' },
    ],
  },
  {
    id: 'play.drifts', symptom: 'It drifts or will not hover level', words: ['drift', 'drifts', 'level', 'lean', 'tilt', 'slides', 'hover', 'trim'],
    steps: [
      { do: 'Check what the flight controller thinks is level right now.', use: { tool: 'read', arguments: { ids: ['attitude.roll', 'attitude.pitch'] } }, why: 'Sitting on a level surface, both should be near zero.' },
      { do: 'If they are not, calibrate level.', use: { tool: 'find', arguments: { query: 'level calibration', kinds: ['test'] } } },
      { do: 'In a position-hold mode, also check GPS and compass.', use: { tool: 'read', arguments: { ids: ['gps.sats', 'sensors.health'] } } },
    ],
  },
  {
    id: 'play.no-radio', symptom: 'The receiver is not working', words: ['receiver', 'radio', 'rx', 'sticks', 'bind', 'signal', 'rssi', 'no', 'channels', 'transmitter', 'elrs', 'crossfire', 'sbus'],
    steps: [
      { do: 'Check whether channels are arriving.', use: { tool: 'run_test', arguments: { id: 'radio.check' } } },
      { do: 'Check the receiver protocol and the port it is wired to.', use: { tool: 'find', arguments: { query: 'receiver protocol port', kinds: ['setting'] } } },
      { do: 'If the settings are right, the receiver may need binding or power. Ask the person to check its light.' },
    ],
  },
  {
    id: 'play.battery-wrong', symptom: 'The battery reading is wrong', words: ['battery', 'voltage', 'reading', 'wrong', 'vbat', 'calibrate', 'low', 'warning', 'current'],
    steps: [
      { do: 'Read what the flight controller measures.', use: { tool: 'run_test', arguments: { id: 'battery.check' } } },
      { do: 'Ask the person for the true voltage from a multimeter or charger.' },
      { do: 'Adjust the voltage scale by the ratio of true to measured.', use: { tool: 'find', arguments: { query: 'battery voltage scale', kinds: ['setting'] } } },
    ],
  },
  {
    id: 'play.flips-on-takeoff', symptom: 'It flips over on takeoff', words: ['flip', 'flips', 'takeoff', 'tumble', 'rolls', 'over', 'launch', 'crash'],
    caution: 'Props off until motor order and direction are confirmed.',
    steps: [
      { do: 'Read the expected motor layout.', use: { tool: 'read', arguments: { ids: ['airframe.layout'] } } },
      { do: 'Spin each motor in turn. The person confirms position and direction against the layout.', use: { tool: 'run_test', arguments: { id: 'motor.spin', args: { motor: 1 } } } },
      { do: 'Check the board orientation setting matches how the flight controller is mounted.', use: { tool: 'find', arguments: { query: 'board orientation alignment', kinds: ['setting'] } } },
      { do: 'Tilt the aircraft by hand and confirm roll and pitch move the right way.', use: { tool: 'read', arguments: { ids: ['attitude.roll', 'attitude.pitch'] } } },
      { do: 'Ask the person to check each prop is the right type for its motor\'s direction.' },
    ],
  },
  {
    id: 'play.no-gps', symptom: 'GPS has no fix', words: ['gps', 'fix', 'satellites', 'sats', 'position', 'no', 'rescue', 'home'],
    steps: [
      { do: 'Read the GPS state.', use: { tool: 'read', arguments: { ids: ['gps.fix', 'gps.sats'] } } },
      { do: 'Zero satellites indoors is normal. Zero satellites outdoors after a few minutes points to wiring or settings.' },
      { do: 'Check the GPS type and the port it is wired to.', use: { tool: 'find', arguments: { query: 'gps type port', kinds: ['setting'] } } },
    ],
  },
  {
    id: 'play.failsafe-setup', symptom: 'Set up failsafe', words: ['failsafe', 'lost', 'signal', 'loss', 'rtl', 'land', 'drop', 'rescue', 'safety'],
    steps: [
      { do: 'Read the current failsafe settings.', use: { tool: 'find', arguments: { query: 'failsafe', kinds: ['setting'] } } },
      { do: 'Explain the choices to the person and let them pick. This decides what the aircraft does when they cannot control it.' },
      { do: 'Propose the change, then ask the person to test it on the bench: props off, switch the transmitter off, watch the result.' },
    ],
  },
  {
    id: 'play.first-setup', symptom: 'Check a new or rebuilt aircraft', words: ['new', 'setup', 'first', 'build', 'check', 'maiden', 'preflight', 'everything', 'health'],
    caution: 'Props off until the last step.',
    steps: [
      { do: 'Run the full check.', use: { tool: 'run_test', arguments: { id: 'diagnostics.full' } } },
      { do: 'Take a settings snapshot as a baseline.', use: { tool: 'run_test', arguments: { id: 'settings.snapshot' } } },
      { do: 'Confirm motor order and direction.', use: { tool: 'find', arguments: { query: 'motor wrong way', kinds: ['playbook'] } } },
      { do: 'Confirm failsafe.', use: { tool: 'find', arguments: { query: 'failsafe', kinds: ['playbook'] } } },
    ],
  },
  {
    id: 'play.backup', symptom: 'Back up or compare settings', words: ['backup', 'back', 'save', 'copy', 'restore', 'snapshot', 'compare', 'diff', 'changed', 'different'],
    steps: [
      { do: 'Take a snapshot. It is saved to the account.', use: { tool: 'run_test', arguments: { id: 'settings.snapshot' } } },
      { do: 'To compare, read the difference against an earlier snapshot.', use: { tool: 'read', arguments: { ids: ['snapshots'] } } },
    ],
  },
  {
    id: 'play.elrs-receiver', symptom: 'Bind or update an ExpressLRS receiver', words: ['elrs', 'expresslrs', 'bind', 'binding', 'receiver', 'update', 'flash', 'firmware', 'crsf', 'pair'], stacks: BF,
    caution: 'Use the firmware built for this exact receiver. The flight controller must be unplugged and replugged afterwards.',
    steps: [
      { do: 'Check the receiver is set up as CRSF on a serial port.', use: { tool: 'read', arguments: { ids: ['bf.serialrx_provider'] } } },
      { do: 'To bind: put the receiver in bind mode, then bind from the transmitter.', use: { tool: 'run_test', arguments: { id: 'receiver.bind' } } },
      { do: 'To update: the person chooses the firmware file and starts the flash.', use: { tool: 'run_test', arguments: { id: 'receiver.flash' } } },
      { do: 'After either, ask the person to unplug and replug the flight controller, then check the radio.', use: { tool: 'run_test', arguments: { id: 'radio.check' } } },
    ],
  },
  {
    id: 'play.esc-passthrough-off', symptom: 'The ESCs cannot be read', words: ['esc', 'escs', 'passthrough', 'read', 'blheli', 'bluejay', 'cannot', 'timeout', 'no', 'answer'], stacks: AP,
    steps: [
      { do: 'Check passthrough is switched on.', use: { tool: 'read', arguments: { ids: ['param.SERVO_BLH_AUTO', 'param.SERVO_BLH_PORT'] } }, why: 'ArduPilot needs SERVO_BLH_AUTO at 1 and SERVO_BLH_PORT at 0 for USB.' },
      { do: 'If not, propose both, then restart the flight controller.', use: { tool: 'propose_change', arguments: { changes: [{ id: 'param.SERVO_BLH_AUTO', value: 1 }, { id: 'param.SERVO_BLH_PORT', value: 0 }] } } },
      { do: 'The ESCs need the flight battery connected, with props removed.' },
    ],
  },
];

export const REFERENCES: Reference[] = [
  { id: 'ref.ap.motors', title: 'Motor order and direction', url: 'https://ardupilot.org/copter/docs/connect-escs-and-motors.html', kind: 'guide', stacks: AP, part: 'motors', words: ['motor', 'order', 'direction', 'spin', 'frame', 'layout', 'esc'] },
  { id: 'ref.ap.prearm', title: 'Arming checks explained', url: 'https://ardupilot.org/copter/docs/common-prearm-safety-checks.html', kind: 'guide', stacks: AP, part: 'safety', words: ['arm', 'arming', 'prearm', 'checks', 'wont'] },
  { id: 'ref.ap.vibration', title: 'Measuring vibration', url: 'https://ardupilot.org/copter/docs/common-measuring-vibration.html', kind: 'guide', stacks: AP, part: 'fc', words: ['vibration', 'shake', 'clipping', 'log'] },
  { id: 'ref.ap.passthrough', title: 'ESC passthrough', url: 'https://ardupilot.org/copter/docs/common-blheli32-passthru.html', kind: 'guide', stacks: AP, part: 'motors', words: ['esc', 'passthrough', 'blheli', 'bluejay'] },
  { id: 'ref.ap.failsafe.radio', title: 'Radio failsafe', url: 'https://ardupilot.org/copter/docs/radio-failsafe.html', kind: 'guide', stacks: AP, part: 'receiver', words: ['failsafe', 'radio', 'loss', 'signal', 'rtl', 'land'] },
  { id: 'ref.ap.failsafe.battery', title: 'Battery failsafe', url: 'https://ardupilot.org/copter/docs/failsafe-battery.html', kind: 'guide', stacks: AP, part: 'battery', words: ['failsafe', 'battery', 'low', 'voltage'] },
  { id: 'ref.ap.accel', title: 'Accelerometer calibration', url: 'https://ardupilot.org/copter/docs/common-accelerometer-calibration.html', kind: 'guide', stacks: AP, part: 'fc', words: ['calibration', 'accelerometer', 'level', 'drift'] },
  { id: 'ref.ap.tuning', title: 'Tuning process', url: 'https://ardupilot.org/copter/docs/tuning-process-instructions.html', kind: 'guide', stacks: AP, part: 'tuning', words: ['tune', 'tuning', 'pid', 'gains', 'filter', 'rate'] },
  { id: 'ref.ap.params', title: 'Every parameter', url: 'https://ardupilot.org/copter/docs/parameters.html', kind: 'guide', stacks: AP, words: ['parameter', 'parameters', 'setting', 'list', 'all'] },
  { id: 'ref.ap.logs', title: 'Reading flight logs', url: 'https://ardupilot.org/copter/docs/common-downloading-and-analyzing-data-logs-in-mission-planner.html', kind: 'guide', stacks: AP, part: 'logging', words: ['log', 'logs', 'dataflash', 'analyse', 'analyze'] },
  { id: 'ref.bf.setup', title: 'Betaflight setup guide', url: 'https://betaflight.com/docs/wiki/getting-started/setup-guide', kind: 'guide', stacks: BF, words: ['setup', 'first', 'new', 'build', 'configure'] },
  { id: 'ref.bf.arming', title: 'Arming flags explained', url: 'https://betaflight.com/docs/wiki/guides/current/Arming-Sequence-And-Safety', kind: 'guide', stacks: BF, part: 'safety', words: ['arm', 'arming', 'flags', 'wont', 'beeps'] },
  { id: 'ref.bf.cli', title: 'Betaflight console commands', url: 'https://betaflight.com/docs/development/Cli', kind: 'guide', stacks: BF, words: ['cli', 'console', 'command', 'set', 'dump', 'diff'] },
  { id: 'ref.bf.flasher', title: 'Flashing Betaflight', url: 'https://betaflight.com/docs/wiki/app/firmware-flasher-tab', kind: 'guide', stacks: BF, part: 'fc', words: ['flash', 'firmware', 'update', 'dfu', 'bootloader'] },
  { id: 'ref.px4.config', title: 'PX4 configuration', url: 'https://docs.px4.io/main/en/config/', kind: 'guide', stacks: ['px4'], words: ['setup', 'configure', 'calibration', 'airframe'] },
  { id: 'ref.px4.safety', title: 'PX4 failsafes', url: 'https://docs.px4.io/main/en/config/safety.html', kind: 'guide', stacks: ['px4'], part: 'safety', words: ['failsafe', 'safety', 'loss', 'rtl', 'land'] },
  { id: 'ref.esc.bluejay', title: 'Bluejay ESC firmware', url: 'https://github.com/bird-sanctuary/bluejay', kind: 'guide', part: 'motors', words: ['bluejay', 'esc', 'firmware', 'blheli', 'melody'] },
  { id: 'ref.esc.configurator', title: 'ESC Configurator', url: 'https://esc-configurator.com/', kind: 'tool', part: 'motors', words: ['esc', 'configurator', 'blheli', 'bluejay', 'am32'] },
  { id: 'ref.video.motor-direction', title: 'Videos: fixing motor direction', url: 'https://www.youtube.com/results?search_query=fpv+drone+motor+direction+wrong+fix', kind: 'video', part: 'motors', words: ['motor', 'direction', 'wrong', 'way', 'reverse', 'video'], note: 'A search, not a single video. Curated timestamps have not been added yet.' },
  { id: 'ref.video.wont-arm', title: 'Videos: why it will not arm', url: 'https://www.youtube.com/results?search_query=fpv+drone+wont+arm+troubleshooting', kind: 'video', part: 'safety', words: ['arm', 'arming', 'wont', 'video'], note: 'A search, not a single video.' },
  { id: 'ref.video.vibration', title: 'Videos: finding vibration', url: 'https://www.youtube.com/results?search_query=fpv+drone+vibration+oscillation+troubleshooting', kind: 'video', part: 'fc', words: ['vibration', 'shake', 'wobble', 'oscillation', 'video'], note: 'A search, not a single video.' },
  { id: 'ref.video.failsafe', title: 'Videos: setting up failsafe', url: 'https://www.youtube.com/results?search_query=fpv+drone+failsafe+setup', kind: 'video', part: 'receiver', words: ['failsafe', 'video', 'setup'], note: 'A search, not a single video.' },
  { id: 'ref.elrs.flashing', title: 'Updating ExpressLRS receivers', url: 'https://www.expresslrs.org/quick-start/receivers/updating/', kind: 'guide', part: 'receiver', words: ['elrs', 'expresslrs', 'receiver', 'update', 'flash', 'firmware'] },
  { id: 'ref.elrs.binding', title: 'Binding ExpressLRS', url: 'https://www.expresslrs.org/quick-start/binding/', kind: 'guide', part: 'receiver', words: ['elrs', 'expresslrs', 'bind', 'binding', 'phrase'] },
  { id: 'ref.bf.vtx', title: 'Betaflight video tables', url: 'https://betaflight.com/docs/wiki/guides/current/VTX-Tables', kind: 'guide', stacks: BF, part: 'vtx', words: ['vtx', 'video', 'table', 'band', 'channel', 'power'] },
  { id: 'ref.bf.osd', title: 'Betaflight OSD', url: 'https://betaflight.com/docs/wiki/app/osd-tab', kind: 'guide', stacks: BF, part: 'osd', words: ['osd', 'display', 'layout', 'elements', 'goggles'] },
  { id: 'ref.esc.am32', title: 'AM32 ESC firmware', url: 'https://github.com/am32-firmware/AM32', kind: 'guide', part: 'motors', words: ['am32', 'esc', 'firmware'] },
  { id: 'ref.bf.blackbox', title: 'Betaflight blackbox', url: 'https://betaflight.com/docs/wiki/guides/current/Black-Box-logging-and-usage', kind: 'guide', stacks: BF, part: 'logging', words: ['blackbox', 'log', 'logs', 'bbl'] },
  { id: 'ref.mav.qgc', title: 'QGroundControl setup', url: 'https://docs.qgroundcontrol.com/master/en/qgc-user-guide/setup_view/setup_view.html', kind: 'guide', stacks: MAV, words: ['qgroundcontrol', 'setup', 'calibration', 'sensors'] },
];

/** Words people use, mapped to the words settings and readings use. */
export const SYNONYMS: Record<string, string[]> = {
  backwards: ['direction', 'reversed'], reverse: ['direction', 'reversed'], spin: ['direction', 'motor'], rotation: ['direction'],
  shake: ['vibration'], shakes: ['vibration'], wobble: ['vibration'], jello: ['vibration'], buzz: ['vibration'],
  volts: ['voltage'], vbat: ['voltage', 'battery'], lipo: ['battery'], cells: ['battery'],
  rx: ['receiver', 'rc'], radio: ['receiver', 'rc'], sticks: ['rc', 'channels'], signal: ['rssi', 'receiver'],
  pid: ['rate', 'tuning', 'p_roll', 'atc'], pids: ['rate', 'tuning'], gains: ['rate', 'tuning'], tune: ['tuning'], rates: ['rate', 'rc_rate'],
  sats: ['satellites', 'gps'], satellites: ['gps'], horizon: ['attitude', 'level'], tilt: ['attitude'], angle: ['attitude'],
  beep: ['beeper', 'beacon', 'beep_strength'], buzzer: ['beeper', 'beacon'], sound: ['beeper', 'melody'],
  vtx: ['video', 'vtx'], camera: ['video', 'osd'], led: ['ledstrip', 'lights'], lights: ['ledstrip', 'ntf'],
  flash: ['firmware'], update: ['firmware'], upgrade: ['firmware'], calibrate: ['calibration', 'cal'], level: ['cal', 'trim', 'attitude'],
  failsafe: ['fs', 'failsafe'], arming: ['arm', 'prearm'], port: ['serial', 'uart'], uart: ['serial'], mode: ['modes', 'fltmode', 'aux'], modes: ['fltmode', 'aux'],
  orientation: ['align', 'ahrs_orientation'], alignment: ['align'], idle: ['dshot_idle', 'spin_arm', 'spin_min'], protocol: ['pwm_type', 'pwm_protocol', 'serialrx'],
  log: ['logs', 'blackbox'], blackbox: ['logs', 'blackbox'], temperature: ['temp'], props: ['yaw_motors_reversed', 'frame'],
};
