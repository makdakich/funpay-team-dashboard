import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const projectRootDir = resolve(rootDir, '..');
const distDir = resolve(rootDir, 'dist');

// Read unified version
let appVersion = '2.1.0';
try {
  const versionFile = resolve(projectRootDir, 'version.json');
  if (fs.existsSync(versionFile)) {
    const vData = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
    appVersion = vData.version || '2.1.0';
  }
} catch (e) {
  console.warn('⚠️ Could not read root version.json, using fallback:', appVersion);
}

async function runBuild() {
  console.log(`🚀 Starting FunPay Hotkeys Extension Build (v${appVersion})...`);

  // Ensure clean dist directory
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  const defineConstants = {
    __APP_VERSION__: JSON.stringify(appVersion)
  };

  // 1. Build Popup
  console.log('📦 Building Popup...');
  await build({
    root: resolve(rootDir, 'src/popup'),
    base: '',
    define: defineConstants,
    build: {
      outDir: resolve(distDir, 'popup'),
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(rootDir, 'src/popup/popup.html'),
        output: {
          entryFileNames: 'popup.js',
          assetFileNames: 'popup.[ext]'
        }
      }
    }
  });

  // 2. Build Options
  console.log('📦 Building Options / Dashboard...');
  await build({
    root: resolve(rootDir, 'src/options'),
    base: '',
    define: defineConstants,
    build: {
      outDir: resolve(distDir, 'options'),
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(rootDir, 'src/options/options.html'),
        output: {
          entryFileNames: 'options.js',
          assetFileNames: 'options.[ext]'
        }
      }
    }
  });

  // 3. Build Content Script (IIFE bundle)
  console.log('📦 Building Content Script...');
  await build({
    root: rootDir,
    define: defineConstants,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, 'src/content/funpay.ts'),
        name: 'FunPayContentScript',
        formats: ['iife'],
        fileName: () => 'content.js'
      },
      rollupOptions: {
        output: {
          extend: true
        }
      }
    }
  });

  // 4. Build Background Service Worker (ESM bundle)
  console.log('📦 Building Service Worker...');
  await build({
    root: rootDir,
    define: defineConstants,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, 'src/background/service-worker.ts'),
        formats: ['es'],
        fileName: () => 'service-worker.js'
      }
    }
  });

  // 5. Copy & sync manifest.json & assets & content styles
  console.log('📄 Copying Manifest & Static Assets...');
  const manifestSrc = resolve(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf-8'));
  manifest.version = appVersion;
  fs.writeFileSync(manifestSrc, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(resolve(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  const assetsDir = resolve(rootDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, resolve(distDir, 'assets'), { recursive: true });
  }

  const contentCss = resolve(rootDir, 'src/content/styles.css');
  if (fs.existsSync(contentCss)) {
    fs.copyFileSync(contentCss, resolve(distDir, 'content.css'));
  }

  console.log('✅ Extension successfully built in dist/');
}

runBuild().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
