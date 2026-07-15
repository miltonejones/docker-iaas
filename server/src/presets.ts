/**
 * The "gallery" of launchable images — analogous to EC2 AMIs / Quick Start.
 * Each preset carries enough metadata for the UI to render a card and for the
 * launch flow to pre-fill sensible defaults (ports, env, volumes).
 */
export interface PresetPort {
  /** Container port, e.g. "80/tcp". */
  container: string;
  /** Suggested host port. */
  host: number;
  label?: string;
}

export interface PresetEnv {
  key: string;
  /** Default value; empty string means "prompt the user". */
  value: string;
  required?: boolean;
  description?: string;
}

/**
 * Structured disk footprint so the UI can weigh a launch against real free
 * space rather than showing a vague string. Numbers are approximate for
 * linux/amd64 and drift by tag/date — they exist to size the *impact*, not to
 * be exact. `download` is the compressed pull; `onDisk` is what lands on the
 * host and shows up under the Docker "Images" footprint.
 */
export interface DiskImpact {
  download: number;
  onDisk: number;
}

export interface Preset {
  id: string;
  name: string;
  category: 'Web' | 'Database' | 'Cache' | 'Runtime' | 'DevOps' | 'OS';
  image: string;
  description: string;
  icon: string;
  ports: PresetPort[];
  env: PresetEnv[];
  /** Named/anonymous volume mount points to persist data. */
  volumes?: string[];
  /** Approximate on-disk / download footprint, in bytes. */
  diskImpact?: DiskImpact;
  /**
   * Bare shell images (OS bases, language runtimes) need a TTY to stay running
   * once launched detached — otherwise the default shell exits immediately.
   */
  interactive?: boolean;
}

/** MB → bytes helper for the approximate figures below (1 MB = 1024 KB). */
const mb = (n: number): number => Math.round(n * 1024 * 1024);

export const PRESETS: Preset[] = [
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'Web',
    image: 'nginx:latest',
    description: 'High-performance web server and reverse proxy.',
    icon: '🌐',
    ports: [{ container: '80/tcp', host: 8080, label: 'HTTP' }],
    env: [],
    diskImpact: { download: mb(70), onDisk: mb(190) },
  },
  {
    id: 'httpd',
    name: 'Apache httpd',
    category: 'Web',
    image: 'httpd:latest',
    description: 'The Apache HTTP Server.',
    icon: '🪶',
    ports: [{ container: '80/tcp', host: 8081, label: 'HTTP' }],
    env: [],
    diskImpact: { download: mb(60), onDisk: mb(170) },
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'Web',
    image: 'wordpress:latest',
    description: 'Blogging / CMS platform (pair with a MySQL instance).',
    icon: '📝',
    ports: [{ container: '80/tcp', host: 8082, label: 'HTTP' }],
    env: [
      { key: 'WORDPRESS_DB_HOST', value: '', description: 'e.g. db-container:3306' },
      { key: 'WORDPRESS_DB_USER', value: 'wordpress' },
      { key: 'WORDPRESS_DB_PASSWORD', value: '', required: true },
      { key: 'WORDPRESS_DB_NAME', value: 'wordpress' },
    ],
    volumes: ['/var/www/html'],
    diskImpact: { download: mb(270), onDisk: mb(700) },
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Database',
    image: 'postgres:16',
    description: 'Object-relational SQL database.',
    icon: '🐘',
    ports: [{ container: '5432/tcp', host: 5432, label: 'Postgres' }],
    env: [
      { key: 'POSTGRES_PASSWORD', value: '', required: true, description: 'Superuser password' },
      { key: 'POSTGRES_USER', value: 'postgres' },
      { key: 'POSTGRES_DB', value: 'postgres' },
    ],
    volumes: ['/var/lib/postgresql/data'],
    diskImpact: { download: mb(145), onDisk: mb(430) },
  },
  {
    id: 'mysql',
    name: 'MySQL',
    category: 'Database',
    image: 'mysql:8',
    description: 'Popular open-source relational database.',
    icon: '🐬',
    ports: [{ container: '3306/tcp', host: 3306, label: 'MySQL' }],
    env: [
      { key: 'MYSQL_ROOT_PASSWORD', value: '', required: true },
      { key: 'MYSQL_DATABASE', value: 'app' },
    ],
    volumes: ['/var/lib/mysql'],
    diskImpact: { download: mb(250), onDisk: mb(600) },
  },
  {
    id: 'mongo',
    name: 'MongoDB',
    category: 'Database',
    image: 'mongo:7',
    description: 'Document-oriented NoSQL database.',
    icon: '🍃',
    ports: [{ container: '27017/tcp', host: 27017, label: 'Mongo' }],
    env: [
      { key: 'MONGO_INITDB_ROOT_USERNAME', value: 'root' },
      { key: 'MONGO_INITDB_ROOT_PASSWORD', value: '', required: true },
    ],
    volumes: ['/data/db'],
    diskImpact: { download: mb(280), onDisk: mb(750) },
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'Cache',
    image: 'redis:7',
    description: 'In-memory data store, cache and message broker.',
    icon: '⚡',
    ports: [{ container: '6379/tcp', host: 6379, label: 'Redis' }],
    env: [],
    volumes: ['/data'],
    diskImpact: { download: mb(45), onDisk: mb(140) },
  },
  {
    id: 'node',
    name: 'Node.js',
    category: 'Runtime',
    image: 'node:20-alpine',
    description: 'JavaScript runtime. Starts an idle shell to build on.',
    icon: '🟢',
    ports: [{ container: '3000/tcp', host: 3000, label: 'App' }],
    env: [],
    interactive: true,
    diskImpact: { download: mb(65), onDisk: mb(180) },
  },
  {
    id: 'python',
    name: 'Python',
    category: 'Runtime',
    image: 'python:3.12-slim',
    description: 'Python runtime for scripts and services.',
    icon: '🐍',
    ports: [{ container: '8000/tcp', host: 8000, label: 'App' }],
    env: [],
    interactive: true,
    diskImpact: { download: mb(45), onDisk: mb(130) },
  },

  // Operating systems — bare boxes you can shell into (`docker exec -it … sh`).
  // Sorted lightest first. All run detached with a TTY so they stay alive.
  {
    id: 'busybox',
    name: 'BusyBox',
    category: 'OS',
    image: 'busybox:latest',
    description: 'Smallest possible box — a single static binary of Unix tools.',
    icon: '📦',
    ports: [
      { container: '80/tcp', host: 8086, label: 'HTTP' },
      { container: '3000/tcp', host: 3006, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(2), onDisk: mb(4) },
  },
  {
    id: 'alpine',
    name: 'Alpine',
    category: 'OS',
    image: 'alpine:3.20',
    description: 'Tiny, security-oriented distro with the apk package manager.',
    icon: '🏔️',
    ports: [
      { container: '80/tcp', host: 8082, label: 'HTTP' },
      { container: '3000/tcp', host: 3002, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(3), onDisk: mb(8) },
  },
  {
    id: 'ubuntu',
    name: 'Ubuntu',
    category: 'OS',
    image: 'ubuntu:24.04',
    description: 'Familiar Debian-based distro with a huge apt ecosystem.',
    icon: '🐧',
    ports: [
      { container: '80/tcp', host: 8080, label: 'HTTP' },
      { container: '3000/tcp', host: 3000, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(28), onDisk: mb(78) },
  },
  {
    id: 'debian-slim',
    name: 'Debian (slim)',
    category: 'OS',
    image: 'debian:12-slim',
    description: 'Debian stable, trimmed — best size/compatibility trade-off.',
    icon: '🌀',
    ports: [
      { container: '80/tcp', host: 8087, label: 'HTTP' },
      { container: '3000/tcp', host: 3007, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(28), onDisk: mb(75) },
  },
  {
    id: 'debian',
    name: 'Debian (full)',
    category: 'OS',
    image: 'debian:12',
    description: 'Full Debian stable base with more preinstalled than slim.',
    icon: '🌀',
    ports: [
      { container: '80/tcp', host: 8081, label: 'HTTP' },
      { container: '3000/tcp', host: 3001, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(48), onDisk: mb(117) },
  },
  {
    id: 'amazonlinux',
    name: 'Amazon Linux',
    category: 'OS',
    image: 'amazonlinux:2023',
    description: 'AWS-tuned RHEL-family base — closest to a real EC2 default.',
    icon: '🟧',
    ports: [
      { container: '80/tcp', host: 8088, label: 'HTTP' },
      { container: '3000/tcp', host: 3008, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(60), onDisk: mb(160) },
  },
  {
    id: 'rockylinux',
    name: 'Rocky (minimal)',
    category: 'OS',
    image: 'rockylinux:9-minimal',
    description: 'RHEL-compatible enterprise base, trimmed to a minimal set.',
    icon: '⛰️',
    ports: [
      { container: '80/tcp', host: 8084, label: 'HTTP' },
      { container: '3000/tcp', host: 3004, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(35), onDisk: mb(92) },
  },
  {
    id: 'almalinux',
    name: 'AlmaLinux',
    category: 'OS',
    image: 'almalinux:9',
    description: 'RHEL-compatible full base with the dnf package manager.',
    icon: '🏛️',
    ports: [
      { container: '80/tcp', host: 8089, label: 'HTTP' },
      { container: '3000/tcp', host: 3009, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(70), onDisk: mb(190) },
  },
  {
    id: 'opensuse',
    name: 'openSUSE Leap',
    category: 'OS',
    image: 'opensuse/leap:15',
    description: 'Enterprise-grade SUSE base with the zypper package manager.',
    icon: '🦎',
    ports: [
      { container: '80/tcp', host: 8090, label: 'HTTP' },
      { container: '3000/tcp', host: 3010, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(45), onDisk: mb(100) },
  },
  {
    id: 'archlinux',
    name: 'Arch Linux',
    category: 'OS',
    image: 'archlinux:latest',
    description: 'Rolling-release distro with pacman. Grows fast as you add tools.',
    icon: '🎗️',
    ports: [
      { container: '80/tcp', host: 8085, label: 'HTTP' },
      { container: '3000/tcp', host: 3005, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(50), onDisk: mb(170) },
  },
  {
    id: 'fedora',
    name: 'Fedora',
    category: 'OS',
    image: 'fedora:40',
    description: 'Cutting-edge RHEL-upstream distro; heaviest of the OS bases.',
    icon: '🎩',
    ports: [
      { container: '80/tcp', host: 8083, label: 'HTTP' },
      { container: '3000/tcp', host: 3003, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(90), onDisk: mb(230) },
  },
  {
    id: 'kali',
    name: 'Kali Linux',
    category: 'OS',
    image: 'kalilinux/kali-rolling:latest',
    description: 'Security/pentest distro. Modest base that balloons with toolsets.',
    icon: '🐉',
    ports: [
      { container: '80/tcp', host: 8091, label: 'HTTP' },
      { container: '3000/tcp', host: 3011, label: 'Dev' },
    ],
    env: [],
    interactive: true,
    diskImpact: { download: mb(130), onDisk: mb(330) },
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
