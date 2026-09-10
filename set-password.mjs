/**
 * Задать логин и пароль для входа в панель.
 *
 *   node set-password.mjs egorprokladka мойпароль
 *
 * Пароль сохраняется хэшем, в открытом виде на диск не попадает.
 * Смена пароля выкидывает из панели всех, кто уже вошёл.
 */
import * as auth from './auth.mjs';

const [user, ...rest] = process.argv.slice(2);
const pass = rest.join(' ');
if (!user || !pass) {
  console.log('как пользоваться:  node set-password.mjs <логин> <пароль>');
  process.exit(1);
}
try {
  console.log(`✓ вход в панель: логин «${auth.setPassword(user, pass)}», пароль сохранён хэшем`);
  console.log('  все, кто был залогинен, разлогинены');
} catch (e) {
  console.log(`✕ ${e.message}`);
  process.exit(1);
}
