import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');

async function runBuild() {
  console.log('🚀 Starting FanPay Hotkeys Extension Build...');

  // Ensure clean dist directory
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Build Popup
  console.log('📦 Building Popup...');
  await build({
    root: resolve(rootDir, 'src/popup'),
    base: '',
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

  // 5. Copy manifest.json & assets & content styles
  console.log('📄 Copying Manifest & Static Assets...');
  fs.copyFileSync(resolve(rootDir, 'manifest.json'), resolve(distDir, 'manifest.json'));

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
