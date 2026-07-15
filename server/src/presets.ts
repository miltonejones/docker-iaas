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
  /** Rough at-a-glance pull size, purely informational for the gallery. */
  approxSize?: string;
}

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
    approxSize: '~190 MB',
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
    approxSize: '~170 MB',
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
    approxSize: '~700 MB',
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
    approxSize: '~430 MB',
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
    approxSize: '~600 MB',
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
    approxSize: '~750 MB',
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
    approxSize: '~140 MB',
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
    approxSize: '~180 MB',
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
    approxSize: '~130 MB',
  },
  {
    id: 'ubuntu',
    name: 'Ubuntu',
    category: 'OS',
    image: 'ubuntu:24.04',
    description: 'A blank Ubuntu box you can shell into.',
    icon: '🐧',
    ports: [],
    env: [],
    approxSize: '~78 MB',
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
