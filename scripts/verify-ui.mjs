// Dependency-free smoke test using an isolated headless Chrome via CDP.
// Start the app on port 3100 and Chrome with remote debugging on port 9223.
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const tabs = await fetch("http://127.0.0.1:9223/json").then((response) => response.json());
const tab = tabs.find((entry) => entry.type === "page");
assert(tab, "Chrome must expose a page on port 9223");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let nextId = 0;
const pending = new Map();
const browserErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const handler = pending.get(message.id);
    if (handler) {
      clearTimeout(handler.timer);
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
    }
  } else if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails.text);
  else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") browserErrors.push(JSON.stringify(message.params.args));
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function setField(selector, value) {
  await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing input'); const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', {bubbles: true})); element.dispatchEvent(new Event('change', {bubbles: true})); })()`);
}
async function clickText(text, scope = "document") {
  await evaluate(`(() => { const button = [...${scope}.querySelectorAll('button')].find(element => element.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)}); button.click(); })()`);
}
const rowCount = "document.querySelectorAll('main tbody tr').length";
const dialog = "document.querySelector('dialog[open]')";
let isolatedProfile = false;
async function anotherPage() {
  const { targetId } = await send('Target.createTarget', { url: 'http://localhost:3100/reservations' });
  const targets = await fetch('http://127.0.0.1:9223/json').then((response) => response.json());
  const target = targets.find((entry) => entry.id === targetId);
  assert(target);
  const connection = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { connection.addEventListener('open', resolve, { once: true }); connection.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const waiting = new Map();
  connection.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handler = waiting.get(message.id);
    if (!handler) return;
    clearTimeout(handler.timer);
    waiting.delete(message.id);
    if (message.error || message.result.exceptionDetails) handler.reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
    else handler.resolve(message.result.result.value);
  });
  return {
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        const messageId = ++id;
        const timer = setTimeout(() => { waiting.delete(messageId); reject(new Error('Second tab timed out')); }, 15000);
        waiting.set(messageId, { resolve, reject, timer });
        connection.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    },
    async close() { connection.close(); await send('Target.closeTarget', { targetId }); },
  };
}
try {
  const command = await send('Browser.getBrowserCommandLine');
  const profileArgument = command.arguments.find((argument) => argument.startsWith('--user-data-dir='));
  assert(profileArgument && resolve(profileArgument.slice('--user-data-dir='.length).replace(/^"|"$/g, '')) === resolve('.browser-test'), 'UI tests require the isolated .browser-test profile; application data must never be reset in a user browser');
  isolatedProfile = true;
  const response = await fetch('http://localhost:3100');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('x-powered-by'), null);
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "http://localhost:3100" });
  await waitFor("document.querySelector('main h1') !== null");
  await evaluate("localStorage.removeItem('salon-manager-reservations-v1'); localStorage.removeItem('salon-manager-customers-v1');");
  await send("Page.reload");
  await waitFor(`${rowCount} === 6`);
  const textColors = await evaluate(`(() => {
    const result = [];
    for (const selector of ['.breadcrumb', '.page-description', '.stat-card p', 'thead th', '.cell-secondary', '.badge', '.nav-label', '.nav-link.selected', '.count']) {
      const element = document.querySelector(selector);
      if (!element) continue;
      let ancestor = element;
      let background;
      while (ancestor) {
        const color = getComputedStyle(ancestor).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; }
        ancestor = ancestor.parentElement;
      }
      result.push({selector, color: getComputedStyle(element).color, background});
    }
    return result;
  })()`);
  function luminance(color) {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  for (const pair of textColors) {
    const values = [luminance(pair.color), luminance(pair.background)].sort((a, b) => b - a);
    assert((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, `Text contrast must reach 4.5:1 for ${pair.selector}`);
  }
  await evaluate("document.querySelector('.skip-link').click()");
  await waitFor("document.activeElement.id === 'main-content'");
  assert.equal(await evaluate("document.querySelector('.stat-number').textContent"), "5件");
  console.log("PASS dashboard: today list and cancellation-aware counts");
  await mkdir(".browser-test", { recursive: true });
  const desktop = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(".browser-test/dashboard-desktop.png", Buffer.from(desktop.data, "base64"));
  await evaluate("document.querySelector('nav a[href=\"/reservations\"]').click()");
  await waitFor(`location.pathname === '/reservations' && ${rowCount} === 8`);
  await setField('[aria-label="予約を検索"]', "山田");
  await waitFor(`${rowCount} === 1`);
  await setField('[aria-label="予約を検索"]', "09012345678");
  await waitFor(`${rowCount} === 1`);
  await clickText("クリア");
  await waitFor(`${rowCount} === 8`);
  const today = await evaluate("(() => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; })()");
  await setField('[aria-label="予約日で絞り込み"]', today);
  await waitFor(`${rowCount} === 6`);
  await setField('[aria-label="ステータスで絞り込み"]', "予約確定");
  await waitFor(`${rowCount} === 3`);
  await clickText("クリア");
  await setField('[aria-label="予約を検索"]', "存在しない顧客");
  await waitFor("document.querySelector('.empty-state h3')?.textContent === '予約がありません'");
  await clickText("クリア");
  console.log("PASS combined search/date/status filtering and empty state");
  await clickText("新規予約");
  await waitFor(`${dialog}?.querySelector('[name=date]').value === ${JSON.stringify(today)}`);
  for (let index = 0; index < 8; index++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert(await evaluate("document.activeElement.closest('dialog') === document.querySelector('dialog[open]')"), 'Keyboard focus must stay in the modal');
  }
  await setField('dialog[open] [name="name"]', "操作テスト 顧客");
  await setField('dialog[open] [name="phone"]', "123");
  await clickText("予約を登録", dialog);
  await waitFor("document.querySelector('dialog[open] [role=alert]')?.textContent.includes('電話番号')");
  await setField('dialog[open] [name="phone"]', "090-1111-2222");
  await setField('dialog[open] [name="time"]', "09:30");
  await clickText("予約を登録", dialog);
  await waitFor("document.querySelector('dialog[open] [role=alert]')?.textContent.includes('すでにあります')");
  await setField('dialog[open] [name="time"]', "18:00");
  await clickText("予約を登録", dialog);
  await waitFor(`${rowCount} === 9 && !${dialog}`);
  console.log("PASS validation, duplicate prevention and reservation creation");
  await evaluate("[...document.querySelectorAll('main tbody tr')].find(row => row.textContent.includes('操作テスト 顧客')).querySelector('button').click()");
  await waitFor(`${dialog}?.querySelector('[name=name]').value === '操作テスト 顧客'`);
  await setField('dialog[open] [name="name"]', "更新テスト 顧客");
  await setField('dialog[open] [name="status"]', "来店済み");
  await clickText("変更を保存", dialog);
  await waitFor("!document.querySelector('dialog[open]') && [...document.querySelectorAll('main tbody tr')].some(row => row.textContent.includes('更新テスト 顧客') && row.textContent.includes('来店済み'))");
  await clickText("新規予約");
  await waitFor(`${dialog}?.querySelector('[name=name]').value === ''`);
  await clickText("キャンセル", dialog);
  await clickText("新規予約");
  await waitFor(`${dialog}?.querySelector('[name=name]').value === ''`);
  await clickText("キャンセル", dialog);
  await send("Page.reload");
  await waitFor(`${rowCount} === 9`);
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).find(item => item.name === '更新テスト 顧客').status"), "来店済み");
  console.log("PASS edit, form reset and persistence after reload");
  await evaluate("[...document.querySelectorAll('main tbody tr')].find(row => row.textContent.includes('更新テスト 顧客')).querySelector('.delete-button').click()");
  await waitFor(`${dialog}?.textContent.includes('予約を削除しますか')`);
  await clickText("戻る", dialog);
  assert.equal(await evaluate(rowCount), 9);
  await evaluate("[...document.querySelectorAll('main tbody tr')].find(row => row.textContent.includes('更新テスト 顧客')).querySelector('.delete-button').click()");
  await waitFor(`${dialog}?.textContent.includes('予約を削除しますか')`);
  await clickText("削除する", dialog);
  await waitFor(`${rowCount} === 8 && !${dialog}`);
  console.log("PASS deletion confirmation and cancellation");
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).filter(item => item.deletedAt).length"), 1);
  await evaluate("document.querySelector('nav a[href=\"/trash\"]').click()");
  await waitFor("location.pathname === '/trash' && document.querySelector('.trash-panel tbody tr')?.textContent.includes('更新テスト 顧客')");
  assert(await evaluate("document.querySelector('.remaining').textContent.includes('時間')"));
  for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 760 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `Trash must fit at ${width}px`);
  }
  await clickText('復元');
  await waitFor("document.querySelector('.trash-panel .empty-state h3')?.textContent === 'ゴミ箱は空です'");
  assert(await evaluate("JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).some(item => item.name === '更新テスト 顧客' && !item.deletedAt && item.status === '来店済み')"));
  await evaluate("document.querySelector('nav a[href=\"/reservations\"]').click()");
  await waitFor(`${rowCount} === 9`);
  await evaluate("[...document.querySelectorAll('main tbody tr')].find(row => row.textContent.includes('更新テスト 顧客')).querySelector('.delete-button').click()");
  await waitFor(`${dialog} !== null`);
  await clickText('削除する', dialog);
  await evaluate("document.querySelector('nav a[href=\"/trash\"]').click()");
  await waitFor("location.pathname === '/trash' && document.querySelector('.trash-panel tbody tr') !== null");
  await clickText('完全削除');
  await waitFor(`${dialog}?.textContent.includes('完全削除した予約は復元できません')`);
  await clickText('戻る', dialog);
  assert.equal(await evaluate(rowCount), 1);
  await clickText('完全削除');
  await waitFor(`${dialog} !== null`);
  await clickText('完全削除する', dialog);
  await waitFor("document.querySelector('.trash-panel .empty-state h3')?.textContent === 'ゴミ箱は空です'");
  assert(await evaluate("!JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).some(item => item.name === '更新テスト 顧客')"));
  console.log('PASS soft deletion, restore, permanent deletion confirmation and responsive trash');
  await evaluate("(() => { const items = JSON.parse(localStorage.getItem('salon-manager-reservations-v1')); const now = Date.now(); items.push({...items[0], id:'expired-test', deletedAt:new Date(now-72*3600000).toISOString()}); items.push({...items[0], id:'retained-test', deletedAt:new Date(now-71*3600000).toISOString()}); localStorage.setItem('salon-manager-reservations-v1', JSON.stringify(items)); })()");
  await send('Page.reload');
  await waitFor(`${rowCount} === 1`);
  assert(await evaluate("(() => { const items = JSON.parse(localStorage.getItem('salon-manager-reservations-v1')); return !items.some(item => item.id === 'expired-test') && items.some(item => item.id === 'retained-test') && items.filter(item => !item.deletedAt).length === 8; })()"));
  await clickText('復元');
  await waitFor("document.querySelector('[role=status]').textContent.includes('同じ日時・担当スタッフ')");
  assert.equal(await evaluate(rowCount), 1);
  await evaluate("(() => { const items = JSON.parse(localStorage.getItem('salon-manager-reservations-v1')); items.find(item => item.id === 'retained-test').deletedAt = new Date(Date.now()-72*3600000+3000).toISOString(); localStorage.setItem('salon-manager-reservations-v1', JSON.stringify(items)); })()");
  await send('Page.reload');
  await waitFor("document.querySelector('.trash-panel .empty-state h3')?.textContent === 'ゴミ箱は空です'");
  assert(await evaluate("!JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).some(item => item.id === 'retained-test')"));
  console.log('PASS 72-hour expiry on startup and while trash stays open; existing records preserved');
  await evaluate("document.querySelector('nav a[href=\"/reservations\"]').click()");
  await waitFor(`${rowCount} === 8`);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor("getComputedStyle(document.querySelector('tbody tr')).display === 'grid'");
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile page must not overflow horizontally");
  const mobile = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(".browser-test/reservations-mobile.png", Buffer.from(mobile.data, "base64"));
  await clickText("新規予約");
  await waitFor(`${dialog} !== null`);
  assert(await evaluate("document.querySelector('dialog[open]').getBoundingClientRect().width <= window.innerWidth"), "Mobile dialog must fit");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!${dialog}`);
  console.log("PASS mobile card layout, dialog size and Escape close");
  for (const width of [320, 768]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 760 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), `Reservation page must fit at ${width}px`);
  }
  await evaluate("document.querySelector('nav a[href=\"/\"]').click()");
  await waitFor("location.pathname === '/' && document.querySelectorAll('.stat-card').length === 3");
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Dashboard must fit at 320px");
  console.log("PASS 320px phone and 768px tablet widths");
  const reservationsBeforeCustomers = await evaluate("localStorage.getItem('salon-manager-reservations-v1')");
  await evaluate("document.querySelector('nav a[href=\"/customers\"]').click()");
  await waitFor("location.pathname === '/customers' && document.querySelectorAll('.customers-panel tbody tr').length >= 8");
  await setField('[aria-label="顧客を検索"]', '山田');
  await waitFor(`${rowCount} === 1`);
  await setField('[aria-label="顧客を検索"]', '０９０１２３４５６７８');
  await waitFor(`${rowCount} === 1`);
  await evaluate("document.querySelector('main .customer-detail-link').click()");
  await waitFor("document.querySelector('.customer-history tbody tr')?.textContent.includes('来店済み')");
  const originalCustomerPath = await evaluate('location.pathname');
  const originalCustomerId = originalCustomerPath.split('/').pop();
  const originalRegistration = await evaluate(`JSON.parse(localStorage.getItem('salon-manager-customers-v1')).find(item => item.id === ${JSON.stringify(originalCustomerId)}).createdAt`);
  await clickText('来店履歴 (1)');
  await waitFor(`${rowCount} === 1`);
  await clickText('編集', "document.querySelector('.customer-profile')");
  await waitFor(`${dialog}?.querySelector('[name=name]').value === '山田 花子'`);
  await setField('dialog[open] [name="name"]', '架空テスト 花子');
  await setField('dialog[open] [name="phone"]', '090-0000-9999');
  await evaluate("document.querySelector('dialog[open] [name=notes]').value = " + JSON.stringify('架空の接客メモ\n<img src=x onerror="window.xssExecuted=true">') + ";");
  await clickText('変更を保存', dialog);
  await waitFor("document.querySelector('.customer-profile h2')?.textContent === '架空テスト 花子'");
  await send('Page.reload');
  await waitFor("document.querySelector('.customer-notes')?.textContent.includes('架空の接客メモ')");
  assert(await evaluate("!document.querySelector('.customer-notes img') && !window.xssExecuted"), 'Customer notes must render as escaped plain text');
  assert(await evaluate("document.querySelector('.customer-history tbody tr').textContent.includes('山田 花子')"));
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('salon-manager-customers-v1')).find(item => item.id === ${JSON.stringify(originalCustomerId)}).createdAt`), originalRegistration);
  for (const width of [320, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 760 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `Customer detail must fit at ${width}px`);
  }
  await clickText('削除', "document.querySelector('.customer-profile')");
  await waitFor(`${dialog}?.textContent.includes('予約・来店履歴・予約のゴミ箱は削除されません')`);
  await clickText('戻る', dialog);
  assert(await evaluate("document.querySelector('.customer-profile h2')?.textContent === '架空テスト 花子'"));
  await clickText('削除', "document.querySelector('.customer-profile')");
  await waitFor(`${dialog} !== null`);
  await clickText('顧客を削除する', dialog);
  await waitFor("location.pathname === '/customers' && document.querySelector('.customers-panel tbody') !== null");
  await send('Page.reload');
  await waitFor("document.querySelector('.customers-panel tbody') !== null");
  assert(await evaluate("!document.querySelector('.customers-panel').textContent.includes('架空テスト 花子')"));
  await clickText('＋ 新規顧客');
  await waitFor(`${dialog} !== null`);
  await setField('dialog[open] [name="name"]', '架空テスト 再登録');
  await setField('dialog[open] [name="phone"]', '09012345678');
  await clickText('顧客を登録', dialog);
  await waitFor("!document.querySelector('dialog[open]') && document.querySelector('.customers-panel').textContent.includes('架空テスト 再登録')");
  await evaluate(`[...document.querySelectorAll('.customer-detail-link')].find(link => link.textContent.includes('架空テスト 再登録')).click()`);
  await waitFor(`location.pathname === ${JSON.stringify(originalCustomerPath)} && document.querySelector('.customer-history tbody tr') !== null`);
  console.log('PASS customer search, detail, visit history, phone edit, notes, reload, deletion and safe re-registration');
  await evaluate("document.querySelector('nav a[href=\"/customers\"]').click()");
  await waitFor("location.pathname === '/customers' && document.querySelector('.customers-panel tbody') !== null");
  await clickText('＋ 新規顧客');
  await waitFor(`${dialog} !== null`);
  await setField('dialog[open] [name="name"]', '架空テスト 新規');
  await setField('dialog[open] [name="phone"]', '０９０－１２３４－５６７８');
  await clickText('顧客を登録', dialog);
  await waitFor("document.querySelector('dialog[open] [role=alert]')?.textContent.includes('すでに登録')");
  await setField('dialog[open] [name="phone"]', '090-0000-1111');
  await clickText('顧客を登録', dialog);
  await waitFor("!document.querySelector('dialog[open]') && document.querySelector('.customers-panel').textContent.includes('架空テスト 新規')");
  await send('Page.reload');
  await waitFor("document.querySelector('.customers-panel')?.textContent.includes('架空テスト 新規')");
  for (const width of [320, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 760 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `Customer list must fit at ${width}px`);
  }
  assert.equal(await evaluate("localStorage.getItem('salon-manager-reservations-v1')"), reservationsBeforeCustomers);
  console.log('PASS customer creation, normalized duplicate prevention, mobile display and byte-for-byte reservation preservation');
  const otherPage = await anotherPage();
  try {
    const deadline = Date.now() + 15000;
    while (!(await otherPage.evaluate("document.querySelector('main .primary') && !document.querySelector('main .primary').disabled"))) {
      assert(Date.now() < deadline, 'Second tab must load');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await evaluate("document.querySelector('nav a[href=\"/reservations\"]').click()");
    await waitFor(`${rowCount} === 8`);
    await evaluate("[...document.querySelectorAll('main tbody tr')].find(row => row.textContent.includes('山田 花子')).querySelector('button').click()");
    await waitFor(`${dialog} !== null`);
    await setField('dialog[open] [name=name]', '架空 未保存の入力');
    await otherPage.evaluate("(() => { const items = JSON.parse(localStorage.getItem('salon-manager-reservations-v1')); items.find(item => item.id === 'sample-1').name = '架空 別タブ更新'; localStorage.setItem('salon-manager-reservations-v1', JSON.stringify(items)); })()");
    await waitFor("document.querySelector('[role=status]').textContent.includes('別のタブ')");
    await clickText('変更を保存', dialog);
    await waitFor("document.querySelector('dialog[open] [role=alert]')?.textContent.includes('変更・削除')");
    assert.equal(await evaluate("document.querySelector('dialog[open] [name=name]').value"), '架空 未保存の入力');
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).find(item => item.id === 'sample-1').name"), '架空 別タブ更新');
    await clickText('キャンセル', dialog);
    await otherPage.evaluate("localStorage.setItem('salon-manager-reservations-v1', " + JSON.stringify(reservationsBeforeCustomers) + ")");
    await waitFor("document.querySelector('main tbody')?.textContent.includes('山田 花子')");
    await clickText('新規予約');
    await waitFor(`${dialog} !== null`);
    await setField('dialog[open] [name=name]', '架空 保存エラー確認');
    await setField('dialog[open] [name=phone]', '09000001234');
    await setField('dialog[open] [name=time]', '19:00');
    await evaluate("window.originalStorageWrite = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new Error('Simulated quota failure'); };");
    await clickText('予約を登録', dialog);
    await waitFor("document.querySelector('dialog[open] [role=alert]')?.textContent.includes('入力内容は保持')");
    assert.equal(await evaluate("document.querySelector('dialog[open] [name=name]').value"), '架空 保存エラー確認');
    await evaluate('Storage.prototype.setItem = window.originalStorageWrite');
    await clickText('キャンセル', dialog);
    const customerSnapshot = await evaluate("localStorage.getItem('salon-manager-customers-v1')");
    const editedCustomer = JSON.parse(customerSnapshot).find((item) => !item.deletedAt);
    await evaluate("document.querySelector('nav a[href=\"/customers\"]').click()");
    await waitFor("location.pathname === '/customers' && document.querySelector('.customers-panel tbody') !== null");
    await evaluate(`document.querySelector('a.customer-detail-link[href="/customers/${editedCustomer.id}"]').closest('tr').querySelector('button').click()`);
    await waitFor(`${dialog} !== null`);
    await otherPage.evaluate(`(() => { const items = JSON.parse(localStorage.getItem('salon-manager-customers-v1')); items.find(item => item.id === ${JSON.stringify(editedCustomer.id)}).notes = '架空 別タブのメモ'; localStorage.setItem('salon-manager-customers-v1', JSON.stringify(items)); })()`);
    await waitFor("document.querySelector('[role=status]').textContent.includes('別のタブの顧客変更')");
    await clickText('変更を保存', dialog);
    await waitFor("document.querySelector('dialog[open] [role=alert]')?.textContent.includes('変更・削除')");
    await clickText('キャンセル', dialog);
    await otherPage.evaluate("localStorage.setItem('salon-manager-customers-v1', " + JSON.stringify(customerSnapshot) + ")");
    await otherPage.evaluate("(() => { const items = JSON.parse(localStorage.getItem('salon-manager-reservations-v1')); items.push({...items[0]}); localStorage.setItem('salon-manager-reservations-v1', JSON.stringify(items)); })()");
    await evaluate("document.querySelector('nav a[href=\"/reservations\"]').click()");
    await waitFor("document.querySelector('[role=status]')?.textContent.includes('上書きせず操作を停止')");
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).length"), 9);
    await otherPage.evaluate("localStorage.setItem('salon-manager-reservations-v1', " + JSON.stringify(reservationsBeforeCustomers) + ")");
    await waitFor(`${rowCount} === 8`);
    await evaluate("document.querySelector('nav a[href=\"/customers\"]').click()");
    await waitFor("location.pathname === '/customers' && document.querySelector('.customers-panel tbody') !== null");
    console.log('PASS real two-tab synchronization, stale edit rejection, failed-save input retention and duplicate-ID protection');
  } finally { await otherPage.close(); }
  await evaluate("localStorage.setItem('salon-manager-customers-v1', '{invalid-customer-json')");
  await send('Page.reload');
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('上書きせず顧客操作を停止')");
  assert.equal(await evaluate("localStorage.getItem('salon-manager-customers-v1')"), '{invalid-customer-json');
  await evaluate("document.querySelector('nav a[href=\"/\"]').click()");
  await waitFor(`${rowCount} === 6`);
  console.log('PASS invalid customer data stays intact and does not stop reservation operations');
  await evaluate("(() => { window.originalStorageWrite = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new Error('Simulated storage failure'); }; document.querySelector('main .delete-button').click(); })()");
  await waitFor(`${dialog} !== null`);
  await clickText('削除する', dialog);
  await waitFor("document.querySelector('[role=status]').textContent.includes('変更は適用されていません')");
  assert.equal(await evaluate(rowCount), 6);
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).filter(item => !item.deletedAt).length"), 8);
  await evaluate("Storage.prototype.setItem = window.originalStorageWrite; localStorage.setItem('salon-manager-reservations-v1', '{invalid-json');");
  await send('Page.reload');
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('上書きせず操作を停止')");
  assert.equal(await evaluate("localStorage.getItem('salon-manager-reservations-v1')"), '{invalid-json');
  assert(await evaluate("document.querySelector('main .primary').disabled"));
  console.log('PASS storage failure and invalid existing data cannot delete or overwrite records');
  await evaluate("localStorage.setItem('salon-manager-reservations-v1', '[]'); localStorage.setItem('salon-manager-customers-v1', '[]');");
  await send('Page.reload');
  await waitFor("document.querySelector('.empty-state h3')?.textContent === '予約がありません'");
  assert.equal(await evaluate("document.querySelector('.stat-number').textContent"), '0件');
  await evaluate("document.querySelector('nav a[href=\"/customers\"]').click()");
  await waitFor("document.querySelector('.empty-state h3')?.textContent === '顧客が登録されていません'");
  await send('Page.navigate', { url: 'http://localhost:3100/customers/not-a-customer' });
  await waitFor("document.querySelector('.empty-state h2')?.textContent === '顧客が見つかりません'");
  console.log('PASS empty datasets, unknown customer, escaped notes, keyboard focus and security headers');
  const beforeReset = await evaluate("JSON.stringify([localStorage.getItem('salon-manager-reservations-v1'),localStorage.getItem('salon-manager-customers-v1')])");
  await clickText('デモデータをリセット');
  await waitFor(`${dialog} !== null`);
  assert(await evaluate("document.querySelector('dialog[open]').textContent.includes('ゴミ箱') && document.querySelector('dialog[open]').textContent.includes('メモ')"));
  await clickText('キャンセル', dialog);
  assert.equal(await evaluate("JSON.stringify([localStorage.getItem('salon-manager-reservations-v1'),localStorage.getItem('salon-manager-customers-v1')])"), beforeReset);
  await evaluate("localStorage.setItem('demo-test-unrelated', 'keep')");
  await clickText('デモデータをリセット');
  await clickText('初期状態に戻す', dialog);
  await waitFor("location.pathname === '/' && document.querySelector('.stat-number')?.textContent !== '0件'");
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('salon-manager-reservations-v1')).length"), 8);
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('salon-manager-customers-v1')).filter(c => !c.deletedAt && !c.notes && c.reservationIds.length === 1).length"), 8);
  assert.equal(await evaluate("localStorage.getItem('demo-test-unrelated')"), 'keep');
  await send('Page.reload');
  await waitFor(`${rowCount} === 6`);
  assert(await evaluate("document.querySelector('.demo-banner').textContent.includes('実際の個人情報は入力しないでください。')"));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
  console.log('PASS demo reset confirmation, cancellation, customer-detail reset, persistence and mobile notice');
  assert.deepEqual(browserErrors, [], "Browser must have no JavaScript errors");
  console.log("PASS no browser JavaScript errors");
} finally {
  if (isolatedProfile) await send("Browser.close").catch(() => {});
  socket.close();
}
