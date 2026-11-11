import { DashboardApp } from './app/app';
import './styles/theme.css';

const root = document.getElementById('app');
if (!root) throw new Error('Не найден корневой элемент #app');

const app = new DashboardApp(root);
void app.start();
window.addEventListener('pagehide', () => app.destroy(), { once: true });
