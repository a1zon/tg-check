/**
 * Общие операции с Telegram Web K. Все селекторы проверены вживую.
 *
 *   меню            #column-left button.sidebar-tools-button -> .btn-menu.active .btn-menu-item
 *   контакты        #contacts-container (кнопка «+», своя строка поиска)
 *   строки списка   a.chatlist-chat  (список виртуализирован, <li> нет)
 *   форма контакта  .popup-create-contact, поля: [0] имя, [1] фамилия, [2] телефон
 *   поле сообщения  .input-message-input[contenteditable]
 *   свой пузырь     .bubble.is-out
 *   удаление контакта: профиль -> карандаш Edit -> Delete Contact (в меню «…» его НЕТ)
 */
export const T = 12_000;

export function createTg(page) {
  const contacts = page.locator('#contacts-container');
  const addBtn = () => contacts.locator('button.btn-circle').first();
  const search = () => contacts.locator('input.input-search-input').first();
  const popup = page.locator('.popup-create-contact').first();
  const fields = () => popup.locator('.input-field-input, [contenteditable="true"]');
  const vis = (l) => l.isVisible().catch(() => false);

  const api = {
    contacts, popup, vis,

    async ready() {
      const st = await Promise.race([
        page.locator('#folders-container, .chatlist').first().waitFor({ timeout: 60_000 }).then(() => 'ok'),
        page.locator('#auth-pages').first().waitFor({ timeout: 60_000 }).then(() => 'noauth'),
      ]).catch(() => 'timeout');
      if (st === 'ok') await page.waitForTimeout(2500);   // даём приложению стать интерактивным
      return st;
    },

    /** Пункт бокового меню. Первый клик может лишь закрыть поиск — жмём до появления меню. */
    async menu(itemText) {
      for (let i = 0; i < 3; i++) {
        if (i > 0) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(500); }
        await page.locator('#column-left button.sidebar-tools-button').first().click({ timeout: T });
        await page.waitForTimeout(800);
        if (await vis(page.locator('.btn-menu.active').first())) {
          await page.locator('.btn-menu.active .btn-menu-item').filter({ hasText: itemText })
            .first().click({ timeout: T });
          return true;
        }
      }
      return false;
    },

    /**
     * Возврат в нейтральное состояние: список чатов, без открытого поиска.
     * После аварийного Escape приложение остаётся в режиме глобального поиска —
     * там кнопка «+» недоступна, и следующая итерация падала по таймауту.
     */
    async resetUi() {
      for (let i = 0; i < 4; i++) {
        const inp = page.locator('#column-left input.input-search-input:visible').first();
        if (await vis(inp)) await inp.fill('').catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
        if (await vis(page.locator('#folders-container').first())) return true;
      }
      return false;
    },

    async goContacts() {
      if (await vis(addBtn())) return;
      if (!(await api.menu('Contacts'))) throw new Error('боковое меню не открылось');
      await addBtn().waitFor({ state: 'visible', timeout: T });
    },

    async clearSearch() {
      if (await vis(search())) await search().fill('').catch(() => {});
    },

    /**
     * Ищем через поиск панели и СВЕРЯЕМ текст строки с меткой.
     * Повторяем: после добавления контакт появляется в списке не мгновенно —
     * одиночная проверка давала ложное «контакт не создался». Замеряли вживую:
     * бывает и через 5-8 секунд после закрытия всплывашки, поэтому шесть попыток.
     * tries=1 для проверки ПОСЛЕ удаления, где ожидается пусто.
     */
    async findRow(label, tries = 6) {
      await api.goContacts();
      await search().click({ timeout: T });
      await search().fill(label);
      const all = contacts.locator('a.chatlist-chat');
      const byLabel = all.filter({ hasText: label }).first();
      for (let i = 0; i < tries; i++) {
        await page.waitForTimeout(i === 0 ? 1100 : 1400);
        // подтолкнуть выдачу: повторный ввод того же запроса заставляет список обновиться
        if (i === 3) await search().fill('').then(() => search().fill(label)).catch(() => {});
        // 1) строка подписана нашей меткой
        if ((await byLabel.count()) > 0) return byLabel;
        // 2) Telegram может показывать НАСТОЯЩЕЕ имя профиля вместо заданного
        //    (в списке стоит «Евгения», а не «9018557772»). Запрос из 10 цифр
        //    номера не может совпасть с двумя людьми, поэтому единственная
        //    строка в отфильтрованном списке — это точно наш контакт.
        if ((await all.count()) === 1) return all.first();
      }
      return null;
    },

    async setField(idx, value) {
      const el = fields().nth(idx);
      await el.click({ timeout: T });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      await page.keyboard.press('Backspace');
      await el.fill(value).catch(() => page.keyboard.type(value, { delay: 25 }));
    },

    /** Добавляет контакт. true — всплывашка закрылась, значит аккаунт есть. */
    async addContact(phone, label) {
      if (!(await vis(popup))) {
        await api.goContacts();
        await api.clearSearch();
        await addBtn().click({ timeout: T });
        await popup.waitFor({ state: 'visible', timeout: T });
      }
      await api.setField(0, label);
      await api.setField(2, phone);
      await popup.getByRole('button', { name: /^(Add|Добавить)$/i }).first().click({ timeout: T });
      const closed = await popup.waitFor({ state: 'hidden', timeout: 10_000 })
        .then(() => true).catch(() => false);
      if (!closed) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(400); }
      return closed;
    },

    async deleteContact(label) {
      try {
        const row = await api.findRow(label);
        if (!row) return false;
        await row.click({ timeout: T });
        await page.waitForTimeout(1400);
        await page.locator('#column-center .peer-title').first().click({ timeout: T });
        await page.waitForTimeout(1600);
        await page.locator('#column-right button.btn-icon.rp:not(.hide)').first().click({ timeout: T });
        await page.waitForTimeout(1400);
        await page.getByText(/^Delete Contact$/i).first().click({ timeout: T });
        await page.waitForTimeout(900);
        await page.locator('.popup-button').filter({ hasText: /^(Delete|Удалить|DELETE)$/i })
          .first().click({ timeout: T });
        await page.waitForTimeout(1400);
        await page.locator('#column-right button.sidebar-close-button').first()
          .click({ timeout: 5000 }).catch(() => {});
        const still = await api.findRow(label, 1);
        await api.clearSearch();
        return !still;
      } catch {
        for (let k = 0; k < 3; k++) await page.keyboard.press('Escape').catch(() => {});
        await api.clearSearch();
        return false;
      }
    },

    /** Настоящее имя профиля из шапки открытого чата. */
    async peerName() {
      return (await page.locator('#column-center .peer-title').first()
        .innerText().catch(() => '')).trim();
    },

    /**
     * Имя подключённого аккаунта. В боковом меню оно стоит отдельным пунктом
     * среди служебных — отсеиваем известные и берём остаток.
     */
    async accountName() {
      const SERVICE = /Add Account|Saved Messages|Archived Chats|My Stories|Contacts|Settings|More|^[\d.]+x$/i;
      try {
        if (!(await vis(page.locator('.btn-menu.active').first()))) {
          await page.locator('#column-left button.sidebar-tools-button').first().click({ timeout: T });
          await page.waitForTimeout(800);
        }
        const items = page.locator('.btn-menu.active .btn-menu-item');
        const n = await items.count();
        let name = '';
        for (let i = 0; i < n; i++) {
          const t = (await items.nth(i).innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
          if (t && !SERVICE.test(t)) { name = t; break; }
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        return name;
      } catch {
        await page.keyboard.press('Escape').catch(() => {});
        return '';
      }
    },

    async openSaved() {
      await api.menu('Saved Messages');
      await page.waitForTimeout(2000);
    },

    /** Пишет в текущий открытый чат. Возвращает текст доставленного пузыря. */
    async sendMessage(text) {
      const box = page.locator('.input-message-input[contenteditable="true"]:visible').first();
      await box.waitFor({ state: 'visible', timeout: T });
      await box.click({ timeout: T });
      await box.fill(text);
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2200);
      const mine = page.locator('.bubble.is-out').last();
      return (await mine.innerText().catch(() => '')).trim();
    },

    /**
     * Кладёт текст в поле ввода и НЕ отправляет. Telegram сохраняет его как
     * черновик, когда уходишь из чата, — получателю ничего не уходит.
     */
    async draftMessage(text) {
      const box = page.locator('.input-message-input[contenteditable="true"]:visible').first();
      await box.waitFor({ state: 'visible', timeout: T });
      await box.click({ timeout: T });
      await box.fill(text);
      await page.waitForTimeout(700);
      await api.goContacts();          // уход из чата = сохранение черновика
      await page.waitForTimeout(1200);
      return true;
    },

    /** Проверяет черновик: открывает чат заново и читает поле ввода. */
    async readDraft(label) {
      const row = await api.findRow(label);
      if (!row) return null;
      await row.click({ timeout: T });
      await page.waitForTimeout(1600);
      const box = page.locator('.input-message-input[contenteditable="true"]:visible').first();
      return (await box.innerText().catch(() => '')).trim();
    },

    /**
     * Жмёт кнопку отправки в открытом чате — отправляет то, что лежит
     * в поле ввода (наш черновик).
     *
     * Кнопка иконочная, доступного текста у неё нет: записанный кодогенератором
     * getByRole('button', { name: '<глифы>' }) цепляется за стопку иконок внутри
     * (send/schedule/edit/mic/video) и ломается при смене набора. Держимся за
     * класс .btn-send — у Web K он стабилен. Ищем строго внутри .chat-input:
     * искать кнопку по всей странице опасно, промах ткнул бы в чужой элемент.
     *
     * Успех подтверждаем фактом: появился новый исходящий пузырь.
     */
    async sendCurrent() {
      const bubbles = page.locator('.bubble.is-out');
      const before = await bubbles.count().catch(() => 0);

      const btn = page.locator('.chat-input button.btn-send').first();
      const clicked = await btn.click({ timeout: T }).then(() => true).catch(() => false);
      // запасной путь — Enter в поле ввода: то же действие, без догадок о разметке
      if (!clicked) await page.keyboard.press('Enter').catch(() => {});

      // ждём именно прирост исходящих, а не просто паузу
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(500);
        if ((await bubbles.count().catch(() => before)) > before) {
          const box = page.locator('.input-message-input[contenteditable="true"]:visible').first();
          return {
            sent: true,
            how: clicked ? 'кнопка' : 'Enter',
            text: (await bubbles.last().innerText().catch(() => '')).trim(),
            left: (await box.innerText().catch(() => '')).trim(),
          };
        }
      }
      return { sent: false, how: clicked ? 'кнопка' : 'Enter', text: '', left: '' };
    },

    /** Удаляет последнее ИСХОДЯЩЕЕ сообщение в открытом чате. */
    async deleteLastOutgoing() {
      try {
        const mine = page.locator('.bubble.is-out').last();
        await mine.click({ button: 'right', timeout: T });
        await page.waitForTimeout(1200);
        await page.locator('.btn-menu.active .btn-menu-item').filter({ hasText: 'Delete' })
          .first().click({ timeout: T });
        await page.waitForTimeout(900);
        await page.locator('.popup-button').filter({ hasText: /^(Delete|Удалить|DELETE)$/i })
          .first().click({ timeout: T });
        await page.waitForTimeout(1200);
        return true;
      } catch {
        for (let k = 0; k < 3; k++) await page.keyboard.press('Escape').catch(() => {});
        return false;
      }
    },
  };
  return api;
}
