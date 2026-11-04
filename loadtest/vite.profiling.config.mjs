import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.join(root, '.baselines/b86324b/frontend');
const { loadConfigFromFile, mergeConfig } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
const original = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(frontend, 'vite.config.ts'), frontend);
if (!original) throw new Error('Cannot load archived b86324b vite.config.ts');
// React DOM 19.2's profiling entry exports createRoot; its profiling CJS
// requires the ordinary scheduler package. There is no scheduler/tracing
// import/export in this version, so no scheduler alias is needed.
export default mergeConfig(original.config, { root: frontend, resolve: { alias: [
  { find: /^react-dom\/client$/, replacement: path.join(frontend, 'node_modules/react-dom/profiling.js') },
] }, build: { outDir: 'dist-profiling', emptyOutDir: true } });
