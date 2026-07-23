import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBolt,
  faBug,
  faArrowUpRightFromSquare,
  faBars,
  faBell,
  faBoxArchive,
  faBucket,
  faCheck,
  faCircleInfo,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleNodes,
  faCode,
  faCopy,
  faCube,
  faDatabase,
  faFeather,
  faFileCode,
  faFolder,
  faGear,
  faGlobe,
  faHardDrive,
  faHouse,
  faLeaf,
  faMagnifyingGlass,
  faPaperPlane,
  faPlus,
  faRightFromBracket,
  faRobot,
  faServer,
  faSpinner,
  faTerminal,
  faTriangleExclamation,
  faUser,
  faVolumeHigh,
  faVolumeXmark,
  faStop,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

const UI_ICONS: Record<string, IconDefinition> = {
  assistant: faWandMagicSparkles,
  menu: faBars,
  bell: faBell,
  spinner: faSpinner,
  database: faDatabase,
  bucket: faBucket,
  bug: faBug,
  container: faBoxArchive,
  folder: faFolder,
  function: faBolt,
  gateway: faCircleNodes,
  warning: faTriangleExclamation,
  external: faArrowUpRightFromSquare,
  info: faCircleInfo,
  home: faHouse,
  user: faUser,
  logout: faRightFromBracket,
  robot: faRobot,
  tool: faGear,
  send: faPaperPlane,
  plus: faPlus,
  check: faCheck,
  'chevron-down': faChevronDown,
  'chevron-right': faChevronRight,
  'chevron-left': faChevronLeft,
  copy: faCopy,
  close: faXmark,
  lookup: faMagnifyingGlass,
  github: faGithub,
  speak: faVolumeHigh,
  'speak-stop': faStop,
  mute: faVolumeXmark,
};

const PRESET_ICONS: Record<string, IconDefinition> = {
  nginx: faGlobe,
  httpd: faFeather,
  wordpress: faFileCode,
  postgres: faDatabase,
  mysql: faDatabase,
  mongo: faLeaf,
  redis: faBolt,
  node: faCode,
  python: faCode,
  ubuntu: faTerminal,
  alpine: faHardDrive,
  debian: faServer,
};

export function AppIcon({ name, className }: { name: keyof typeof UI_ICONS; className?: string }) {
  return <FontAwesomeIcon icon={UI_ICONS[name]} className={className} fixedWidth aria-hidden />;
}

export function PresetIcon({ id }: { id: string }) {
  return <FontAwesomeIcon icon={PRESET_ICONS[id] ?? faCube} fixedWidth aria-hidden />;
}

export function RuntimeIcon({ id }: { id: string }) {
  return <FontAwesomeIcon icon={id === 'sh' ? faTerminal : faCode} fixedWidth aria-hidden />;
}
