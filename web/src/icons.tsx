import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBolt,
  faArrowUpRightFromSquare,
  faBars,
  faBoxArchive,
  faBucket,
  faCheck,
  faCircleNodes,
  faCode,
  faCube,
  faDatabase,
  faFeather,
  faFileCode,
  faFolder,
  faGear,
  faGlobe,
  faHardDrive,
  faHouse,
  faLayerGroup,
  faLeaf,
  faMagnifyingGlass,
  faMicrochip,
  faPaperPlane,
  faPlus,
  faRobot,
  faServer,
  faTerminal,
  faTriangleExclamation,
  faUser,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

const UI_ICONS: Record<string, IconDefinition> = {
  assistant: faWandMagicSparkles,
  menu: faBars,
  bucket: faBucket,
  container: faBoxArchive,
  folder: faFolder,
  function: faBolt,
  gateway: faCircleNodes,
  warning: faTriangleExclamation,
  external: faArrowUpRightFromSquare,
  home: faHouse,
  user: faUser,
  robot: faRobot,
  tool: faGear,
  send: faPaperPlane,
  plus: faPlus,
  check: faCheck,
  close: faXmark,
  lookup: faMagnifyingGlass,
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

export function AppIcon({ name }: { name: keyof typeof UI_ICONS }) {
  return <FontAwesomeIcon icon={UI_ICONS[name]} fixedWidth aria-hidden />;
}

export function PresetIcon({ id }: { id: string }) {
  return <FontAwesomeIcon icon={PRESET_ICONS[id] ?? faCube} fixedWidth aria-hidden />;
}

export function RuntimeIcon({ id }: { id: string }) {
  return <FontAwesomeIcon icon={id === 'sh' ? faTerminal : faCode} fixedWidth aria-hidden />;
}
