// Static scaffolding around the AI-generated files. None of this needs an
// LLM call -- it's the same shape for every app, just parameterized by the
// contract's app name and model list, so it's generated deterministically.

export function buildScaffold(contract) {
  const appName = contract.appName || 'generated-app';
  // Exact model name, case-preserved -- must match the filename convention
  // the agents are told to follow (models/<Name>.js, routes/<Name>.js), or
  // this import statement points at a file that doesn't exist.
  const modelNames = contract.models.map((m) => m.name);
  const files = {};

  // ---- backend/server.js ----
  const importLines = modelNames
    .map((name) => "import " + name + "Router from './routes/" + name + ".js';")
    .join('\n');
  const mountLines = modelNames.map((name) => 'app.use(' + name + 'Router);').join('\n');

  files['backend/server.js'] = [
    "import express from 'express';",
    "import cors from 'cors';",
    "import mongoose from 'mongoose';",
    "import 'dotenv/config';",
    importLines,
    '',
    'const app = express();',
    'app.use(cors());',
    'app.use(express.json());',
    '',
    mountLines,
    '',
    'const PORT = process.env.PORT || 5000;',
    "const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/" + appName + "';",
    '',
    'mongoose.connect(MONGODB_URI)',
    '  .then(() => {',
    "    app.listen(PORT, () => console.log('Backend running at http://localhost:' + PORT));",
    '  })',
    '  .catch((err) => {',
    "    console.error('MongoDB connection failed:', err.message);",
    '    process.exit(1);',
    '  });',
    ''
  ].join('\n');

  // ---- backend/package.json ----
  files['backend/package.json'] =
    JSON.stringify(
      {
        name: appName + '-backend',
        private: true,
        type: 'module',
        scripts: { dev: 'node --watch server.js', start: 'node server.js' },
        dependencies: {
          cors: '^2.8.5',
          dotenv: '^16.4.5',
          express: '^4.19.2',
          mongoose: '^8.5.0'
        }
      },
      null,
      2
    ) + '\n';

  files['backend/.env.example'] = ['MONGODB_URI=mongodb://127.0.0.1:27017/' + appName, 'PORT=5000', ''].join('\n');

  // ---- frontend/package.json ----
  files['frontend/package.json'] =
    JSON.stringify(
      {
        name: appName + '-frontend',
        private: true,
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0' }
      },
      null,
      2
    ) + '\n';

  // ---- frontend/vite.config.js (proxies /api to the backend so relative fetch() calls just work) ----
  files['frontend/vite.config.js'] = [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    '',
    "// Proxy target must match backend/.env's PORT -- if you change one, change both.",
    'export default defineConfig({',
    '  plugins: [react()],',
    '  server: {',
    '    proxy: {',
    "      '/api': 'http://localhost:5000'",
    '    }',
    '  }',
    '});',
    ''
  ].join('\n');

  files['frontend/index.html'] = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<title>' + appName + '</title>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    '<script type="module" src="/src/main.jsx"></script>',
    '</body>',
    '</html>',
    ''
  ].join('\n');

  files['frontend/src/main.jsx'] = [
    "import React from 'react';",
    "import ReactDOM from 'react-dom/client';",
    "import App from './App.jsx';",
    '',
    "ReactDOM.createRoot(document.getElementById('root')).render(",
    '  <React.StrictMode>',
    '    <App />',
    '  </React.StrictMode>',
    ');',
    ''
  ].join('\n');

  // ---- frontend/src/App.jsx ----
  // Deterministic, not LLM-generated: it just imports and renders every
  // model's list component. Generating this ourselves means it's always
  // correct for the *current* full model list even on an incremental
  // rebuild, where most components are being reused, untouched, from a
  // previous build rather than regenerated this time -- asking the frontend
  // agent to write this file would require it to know the exact component
  // filenames of models it never actually saw the code for.
  const appImportLines = modelNames.map((name) => `import ${name}List from './components/${name}List.jsx';`).join('\n');
  const appRenderLines = modelNames.map((name) => `      <${name}List />`).join('\n');
  files['frontend/src/App.jsx'] = [
    "import React from 'react';",
    appImportLines,
    '',
    'export default function App() {',
    '  return (',
    '    <div className="app">',
    `      <h1>${appName}</h1>`,
    appRenderLines,
    '    </div>',
    '  );',
    '}',
    ''
  ].join('\n');

  files['README.md'] = [
    '# ' + appName,
    '',
    'Generated by the multi-agent builder.',
    '',
    '## Run it',
    '',
    '**Backend** (terminal 1):',
    '```',
    'cd backend',
    'npm install',
    'cp .env.example .env   # make sure MongoDB is running locally, or point MONGODB_URI at Atlas',
    'npm run dev',
    '```',
    '',
    '**Frontend** (terminal 2):',
    '```',
    'cd frontend',
    'npm install',
    'npm run dev',
    '```',
    '',
    'Then open the Vite URL it prints (usually http://localhost:5173).',
    ''
  ].join('\n');

  return files;
}

// The agents generate flat paths (models/X.js, routes/x.js, src/App.jsx, ...).
// The validator checks those flat paths, so this remapping happens *after*
// validation, purely as a packaging step, to avoid touching agent/validator logic.
export function remapGeneratedFiles(files) {
  const remapped = {};
  for (const [relPath, content] of Object.entries(files)) {
    if (relPath.startsWith('models/') || relPath.startsWith('routes/')) {
      remapped['backend/' + relPath] = content;
    } else if (relPath.startsWith('src/')) {
      remapped['frontend/' + relPath] = content;
    } else {
      remapped[relPath] = content;
    }
  }
  return remapped;
}
