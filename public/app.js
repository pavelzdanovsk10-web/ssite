const state = {
  config: null,
  me: null,
  dashboard: null,
  users: [],
  events: [],
  ranking: [],
  conversations: [],
  activeConversationId: null,
  socket: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  })[character]);
}

function roleName(role) {
  return ({ owner: 'Владелец', admin: 'Администратор', supervisor: 'Куратор', employee: 'Администратор сервера' })[role] || role;
}

function statusName(status) {
  return ({ active: 'Проводится', completed: 'Завершён', cancelled: 'Отменён', forced: 'Завершён принудительно' })[status] || status;
}

function formatDate(value, includeTime = true) {
  if (!value) return '—';
  const date = new Date(String(value).includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', includeTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDuration(seconds = 0) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours} ч ${minutes} мин`;
  return `${Math.floor(total / 60)} мин`;
}

function initials(user) {
  return escapeHtml((user.nickname || user.login || '?').slice(0, 2).toUpperCase());
}

function avatarHtml(user, className = 'avatar') {
  return user.avatar
    ? `<img class="${className}" src="${escapeHtml(user.avatar)}" alt="">`
    : `<div class="${className}">${initials(user)}</div>`;
}

async function api(url, options = {}) {
  const request = { credentials: 'same-origin', ...options };
  if (!(options.body instanceof FormData)) {
    request.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  }
  const response = await fetch(url, request);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(node.hideTimer);
  node.hideTimer = setTimeout(() => node.classList.remove('show'), 2800);
}

function isManager() {
  return state.me && ['owner', 'admin', 'supervisor'].includes(state.me.role);
}

function canManage(user) {
  if (!state.me) return false;
  if (state.me.role === 'owner') return user.role !== 'owner' || user.id === state.me.id;
  if (state.me.role === 'admin') return !['owner', 'admin'].includes(user.role);
  if (state.me.role === 'supervisor') return user.role === 'employee' && user.accessLevel < state.me.accessLevel;
  return false;
}

function setView(name, updateHash = true) {
  const available = $(`#view-${name}`) && !($(`[data-view="${name}"]`)?.classList.contains('hidden'));
  const target = available ? name : 'profile';
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${target}`));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === target));
  $('#main-nav').classList.remove('open');
  $('#strip-document').textContent = ({
    profile: 'ADM/PERSONAL/01', events: 'ADM/EVENTS/02', ranking: 'ADM/RANKING/03',
    staff: 'ADM/STAFF/04', chat: 'ADM/COMMS/05', audit: 'ADM/AUDIT/06'
  })[target] || 'ADM/PERSONAL/01';
  if (updateHash) history.replaceState(null, '', `#${target}`);
  if (target === 'events') loadEvents();
  if (target === 'ranking') loadRanking();
  if (target === 'staff') loadUsers();
  if (target === 'chat') loadConversations();
  if (target === 'audit') loadAudit();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyPermissions() {
  const admin = ['owner', 'admin'].includes(state.me.role);
  $$('.admin-only').forEach(element => element.classList.toggle('hidden', !admin));
  ['events', 'ranking', 'staff', 'chat'].forEach(view => {
    document.querySelectorAll(`[data-view="${view}"]`).forEach(element => element.classList.toggle('hidden', !state.me.approved));
  });
}

function renderCurrentUser() {
  $('#current-user-mini').innerHTML = `${avatarHtml(state.me)}<div><b>${escapeHtml(state.me.nickname)}</b><span>${escapeHtml(state.me.position || roleName(state.me.role))} · L${state.me.accessLevel}</span></div>`;
  $('#strip-level').textContent = state.me.accessLevel;
  $('#strip-status').textContent = state.me.approved ? String(state.me.status || 'Активен').toUpperCase() : 'ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ';
  $('#pending-banner').classList.toggle('hidden', state.me.approved);
}

function renderProfile() {
  const { user, events, discipline } = state.dashboard;
  state.me = user;
  renderCurrentUser();

  $('#profile-avatar').innerHTML = user.avatar
    ? `<img src="${escapeHtml(user.avatar)}" alt="">`
    : initials(user);
  $('#profile-record-id').textContent = `ADM-${String(user.id).padStart(4, '0')}`;
  $('#profile-name').textContent = user.nickname;
  $('#profile-position').textContent = user.position || 'Должность не назначена';
  $('#profile-level').textContent = `ДОПУСК ${user.accessLevel}`;
  $('#profile-status').textContent = user.approved ? String(user.status || 'Активен').toUpperCase() : 'ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ';
  $('#profile-status').classList.toggle('pending', !user.approved);

  const metrics = [
    ['Баллы', user.eventPoints, 'PTS'],
    ['Ивенты', user.eventCount, 'EVT'],
    ['Устные', `${user.verbalWarnings}/3`, 'VRB'],
    ['Строгие', `${user.strictReprimands}/3`, 'STR'],
    ['Время ивентов', formatDuration(user.totalEventSeconds), 'TIME']
  ];
  $('#profile-stats').innerHTML = metrics.map(([label, value, code]) => `
    <div class="metric-card" data-code="${code}"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>
  `).join('');

  const serviceRows = [
    ['Должность', user.position || 'Не назначена'],
    ['Системная роль', roleName(user.role)],
    ['Уровень допуска', `Уровень ${user.accessLevel}`],
    ['Статус', user.approved ? user.status : 'Ожидает подтверждения'],
    ['Дата регистрации', formatDate(user.createdAt, false)],
    ['Последний ивент', user.lastEventAt ? formatDate(user.lastEventAt) : 'Не проводился'],
    ['Общее время ивентов', formatDuration(user.totalEventSeconds)]
  ];
  $('#service-data').innerHTML = serviceRows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');

  $('#integration-cards').innerHTML = `
    <div class="integration-card">
      <div class="integration-icon discord">DS</div>
      <div><strong>Discord</strong><small>${user.discordLinked ? escapeHtml(user.discordUsername || user.discordId) : 'Аккаунт не привязан'}</small></div>
      <div class="integration-actions">
        ${user.discordLinked
          ? `<button data-unlink="discord" type="button">Отвязать</button>`
          : `<a href="/api/integrations/discord/start">Привязать</a>`}
      </div>
    </div>
    <div class="integration-card">
      <div class="integration-icon steam">ST</div>
      <div><strong>Steam</strong><small>${user.steamLinked ? escapeHtml(user.steamUsername || user.steamId) : 'Аккаунт не привязан'}</small></div>
      <div class="integration-actions">
        ${user.steamLinked
          ? `<button data-unlink="steam" type="button">Отвязать</button>`
          : `<a href="/api/integrations/steam/start">Привязать</a>`}
      </div>
    </div>
  `;
  $$('[data-unlink]').forEach(button => button.addEventListener('click', () => unlinkIntegration(button.dataset.unlink)));

  renderDisciplineTable($('#my-discipline'), discipline, false);
  $('#my-event-total').textContent = `${user.eventCount} ${pluralEvent(user.eventCount)}`.toUpperCase();
  renderEventsTable($('#my-events'), events, { personal: true });
}

function pluralEvent(value) {
  const n = Math.abs(Number(value)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return 'ивентов';
  if (n1 > 1 && n1 < 5) return 'ивента';
  if (n1 === 1) return 'ивент';
  return 'ивентов';
}

function renderDisciplineTable(container, items, manageable = false) {
  container.innerHTML = `
    <table>
      <thead><tr><th>Тип</th><th>Причина</th><th>Выдал</th><th>Дата</th><th>Статус</th>${manageable ? '<th></th>' : ''}</tr></thead>
      <tbody>
        ${items.length ? items.map(item => `
          <tr>
            <td>${item.type === 'strict' ? 'Строгий выговор' : 'Устное предупреждение'}</td>
            <td>${escapeHtml(item.reason)}</td>
            <td>${escapeHtml(item.issuer_name || 'Система')}</td>
            <td>${formatDate(item.issued_at)}</td>
            <td><span class="status-text ${item.status === 'active' ? 'active' : ''}">${item.status === 'active' ? 'Активно' : 'Снято'}</span></td>
            ${manageable ? `<td>${item.status === 'active' ? `<button class="table-action remove-discipline" data-id="${item.id}">Снять</button>` : ''}</td>` : ''}
          </tr>`).join('') : `<tr><td colspan="${manageable ? 6 : 5}" class="empty-row">Дисциплинарных записей нет.</td></tr>`}
      </tbody>
    </table>`;
  if (manageable) {
    container.querySelectorAll('.remove-discipline').forEach(button => button.addEventListener('click', () => removeDiscipline(Number(button.dataset.id))));
  }
}

function renderEventsTable(container, events, options = {}) {
  const personal = Boolean(options.personal);
  container.innerHTML = `
    <table>
      <thead><tr><th>Ивент</th>${personal ? '' : '<th>Организатор</th>'}<th>Время</th><th class="numeric">Баллы</th><th>Статус</th></tr></thead>
      <tbody>
        ${events.length ? events.map(event => `
          <tr>
            <td>${escapeHtml(event.name)}</td>
            ${personal ? '' : `<td>${escapeHtml(event.host_name || event.host_steam_id || 'Не привязан')}</td>`}
            <td>${formatDuration(event.duration_seconds)}</td>
            <td class="numeric points-positive">${Number(event.points_awarded) > 0 ? `+${event.points_awarded}` : '0'}</td>
            <td><span class="status-text ${event.status}">${statusName(event.status)}</span></td>
          </tr>`).join('') : `<tr><td colspan="${personal ? 4 : 5}" class="empty-row">Ивенты пока не проводились.</td></tr>`}
      </tbody>
    </table>`;
}

async function loadDashboard() {
  const data = await api('/api/me/dashboard');
  state.dashboard = data;
  renderProfile();
}

function renderEventRules() {
  const rules = [
    ['Короче 10 минут', '0', 'баллов'],
    ['10–30 минут', '2', 'балла'],
    ['30–60 минут', '3', 'балла'],
    ['Более 60 минут', '5', 'баллов']
  ];
  $('#event-rule-cards').innerHTML = rules.map(([time, points, word]) => `
    <div class="rule-card"><span>${time}</span><b><strong>${points}</strong> ${word}</b></div>
  `).join('');
}

async function loadEvents() {
  try {
    const data = await api('/api/events?limit=200');
    state.events = data.events;
    renderEventsTable($('#events-table'), state.events);
  } catch (error) {
    $('#events-table').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

async function loadRanking() {
  try {
    const data = await api('/api/ranking');
    state.ranking = data.users;
    const top = state.ranking.slice(0, 3);
    const ordered = top.length === 3 ? [top[1], top[0], top[2]] : top;
    $('#ranking-podium').innerHTML = ordered.map(user => {
      const place = state.ranking.indexOf(user) + 1;
      return `<article class="podium-card ${place === 1 ? 'first' : ''}">
        <span class="place">${place}</span>${avatarHtml(user, 'avatar-lg')}
        <h3>${escapeHtml(user.nickname)}</h3><p>${escapeHtml(user.position || 'Администратор')}</p>
        <div class="podium-score">${user.event_points} балл.</div>
      </article>`;
    }).join('') || '<p class="muted">Рейтинг пока пуст.</p>';
    $('#ranking-table').innerHTML = `
      <table><thead><tr><th>Место</th><th>Администратор</th><th>Должность</th><th class="numeric">Ивенты</th><th class="numeric">Время</th><th class="numeric">Баллы</th></tr></thead>
      <tbody>${state.ranking.length ? state.ranking.map((user, index) => `
        <tr><td>${index + 1}</td><td>${escapeHtml(user.nickname)}</td><td>${escapeHtml(user.position || '—')}</td><td class="numeric">${user.event_count}</td><td class="numeric">${formatDuration(user.total_event_seconds)}</td><td class="numeric points-positive">${user.event_points}</td></tr>
      `).join('') : '<tr><td colspan="6" class="empty-row">Данных пока нет.</td></tr>'}</tbody></table>`;
  } catch (error) {
    $('#ranking-table').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

function filteredUsers() {
  const query = ($('#staff-search').value || '').toLowerCase().trim();
  const filter = $('#staff-filter').value;
  return state.users.filter(user => {
    const matchesQuery = [user.nickname, user.position, user.discordUsername, user.discordId, user.steamUsername, user.steamId]
      .some(value => String(value || '').toLowerCase().includes(query));
    const matchesStatus = filter === 'all' || (filter === 'approved' && user.approved) || (filter === 'pending' && !user.approved);
    return matchesQuery && matchesStatus;
  });
}

function renderStaff() {
  const users = filteredUsers();
  $('#staff-grid').innerHTML = users.map(user => `
    <article class="staff-card ${user.approved ? '' : 'pending'}">
      <div class="staff-top">
        ${avatarHtml(user, 'avatar-lg')}
        <div><h3>${escapeHtml(user.nickname)}</h3><p>${escapeHtml(user.position || 'Должность не назначена')}</p>
          <div class="staff-badges"><span class="tiny-badge">L${user.accessLevel}</span><span class="tiny-badge">${user.approved ? escapeHtml(user.status) : 'Ожидает подтверждения'}</span></div>
        </div>
      </div>
      <div class="staff-stats">
        <div class="staff-stat"><span>Баллы</span><b>${user.eventPoints}</b></div>
        <div class="staff-stat"><span>Ивенты</span><b>${user.eventCount}</b></div>
        <div class="staff-stat"><span>Устные</span><b>${user.verbalWarnings}/3</b></div>
        <div class="staff-stat"><span>Строгие</span><b>${user.strictReprimands}/3</b></div>
      </div>
      <div class="connection-line">
        <span class="${user.discordLinked ? 'connection-ok' : 'connection-missing'}">Discord: ${user.discordLinked ? escapeHtml(user.discordUsername || 'привязан') : 'не привязан'}</span>
        <span>·</span>
        <span class="${user.steamLinked ? 'connection-ok' : 'connection-missing'}">Steam: ${user.steamLinked ? escapeHtml(user.steamUsername || 'привязан') : 'не привязан'}</span>
      </div>
      <div class="card-actions">
        <button class="outline-button view-profile-btn" data-id="${user.id}" type="button">Досье</button>
        ${canManage(user) ? `<button class="outline-button edit-user-btn" data-id="${user.id}" type="button">Изменить</button>` : ''}
      </div>
    </article>
  `).join('') || '<p class="muted">Сотрудники не найдены.</p>';
  $$('.view-profile-btn').forEach(button => button.addEventListener('click', () => openStaffProfile(Number(button.dataset.id))));
  $$('.edit-user-btn').forEach(button => button.addEventListener('click', () => openUserDialog(Number(button.dataset.id))));
}

async function loadUsers() {
  const data = await api('/api/users');
  state.users = data.users;
  renderStaff();
}

function openUserDialog(id = null) {
  const form = $('#user-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.login.disabled = Boolean(id);
  form.elements.password.required = !id;
  form.elements.approved.checked = true;
  $('#user-form-error').textContent = '';
  $('#delete-user-btn').classList.add('hidden');
  $('#user-modal-title').textContent = id ? 'Карточка сотрудника' : 'Новый сотрудник';

  if (id) {
    const user = state.users.find(item => item.id === id);
    if (!user) return;
    form.elements.id.value = user.id;
    form.elements.login.value = user.login || '';
    form.elements.nickname.value = user.nickname;
    form.elements.position.value = user.position || '';
    form.elements.role.value = user.role;
    form.elements.accessLevel.value = user.accessLevel;
    form.elements.strictReprimands.value = user.strictReprimands;
    form.elements.verbalWarnings.value = user.verbalWarnings;
    form.elements.discordId.value = user.discordId || '';
    form.elements.discordUsername.value = user.discordUsername || '';
    form.elements.steamId.value = user.steamId || '';
    form.elements.steamUsername.value = user.steamUsername || '';
    form.elements.status.value = user.status || 'Активен';
    form.elements.approved.checked = user.approved;
    if (['owner', 'admin'].includes(state.me.role) && user.role !== 'owner' && user.id !== state.me.id) $('#delete-user-btn').classList.remove('hidden');
  }
  $('#user-dialog').showModal();
}

async function submitUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const id = Number(values.id || 0);
  const payload = {
    login: values.login,
    password: values.password || undefined,
    nickname: values.nickname,
    position: values.position,
    role: values.role,
    accessLevel: Number(values.accessLevel),
    strictReprimands: Number(values.strictReprimands),
    verbalWarnings: Number(values.verbalWarnings),
    discordId: values.discordId,
    discordUsername: values.discordUsername,
    steamId: values.steamId,
    steamUsername: values.steamUsername,
    status: values.status,
    approved: form.elements.approved.checked
  };
  try {
    await api(id ? `/api/users/${id}` : '/api/users', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    $('#user-dialog').close();
    await loadUsers();
    if (id === state.me.id) await loadDashboard();
    toast(id ? 'Досье обновлено.' : 'Аккаунт создан.');
  } catch (error) {
    $('#user-form-error').textContent = error.message;
  }
}

async function deleteUser() {
  const id = Number($('#user-form').elements.id.value);
  if (!id || !confirm('Удалить аккаунт и связанные с ним данные?')) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    $('#user-dialog').close();
    await loadUsers();
    toast('Аккаунт удалён.');
  } catch (error) {
    $('#user-form-error').textContent = error.message;
  }
}

async function openStaffProfile(id) {
  try {
    const data = await api(`/api/users/${id}/profile`);
    const user = data.user;
    $('#staff-profile-title').textContent = user.nickname;
    $('#staff-profile-body').innerHTML = `
      <div class="profile-summary">${avatarHtml(user, 'avatar-lg')}<div><h2>${escapeHtml(user.nickname)}</h2><p>${escapeHtml(user.position || 'Не назначена')} · допуск ${user.accessLevel}</p></div></div>
      <div class="metric-grid">
        <div class="metric-card" data-code="PTS"><span>Баллы</span><strong>${user.eventPoints}</strong></div>
        <div class="metric-card" data-code="EVT"><span>Ивенты</span><strong>${user.eventCount}</strong></div>
        <div class="metric-card" data-code="VRB"><span>Устные</span><strong>${user.verbalWarnings}/3</strong></div>
        <div class="metric-card" data-code="STR"><span>Строгие</span><strong>${user.strictReprimands}/3</strong></div>
      </div>
      ${canManage(user) ? `<div class="profile-modal-actions"><button id="issue-discipline-btn" class="primary" type="button">Выдать взыскание</button><button id="edit-from-profile-btn" class="outline-button" type="button">Изменить досье</button></div>` : ''}
      <div class="panel-title"><span>Д-A</span><div><p>ДИСЦИПЛИНА</p><h3>Предупреждения</h3></div></div>
      <div id="staff-discipline-table" class="responsive-table"></div>
      <div class="panel-title"><span>Д-B</span><div><p>АРХИВ</p><h3>Ивенты</h3></div></div>
      <div id="staff-events-table" class="responsive-table"></div>`;
    renderDisciplineTable($('#staff-discipline-table'), data.discipline, canManage(user));
    renderEventsTable($('#staff-events-table'), data.events, { personal: true });
    $('#issue-discipline-btn')?.addEventListener('click', () => openDisciplineDialog(user.id));
    $('#edit-from-profile-btn')?.addEventListener('click', () => { $('#profile-dialog').close(); openUserDialog(user.id); });
    $('#profile-dialog').showModal();
  } catch (error) {
    toast(error.message);
  }
}

function openDisciplineDialog(userId) {
  const form = $('#discipline-form');
  form.reset();
  form.elements.userId.value = userId;
  $('#discipline-form-error').textContent = '';
  $('#discipline-dialog').showModal();
}

async function submitDiscipline(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/users/${values.userId}/discipline`, { method: 'POST', body: JSON.stringify(values) });
    $('#discipline-dialog').close();
    $('#profile-dialog').close();
    await loadUsers();
    await openStaffProfile(Number(values.userId));
    toast('Взыскание зафиксировано.');
  } catch (error) {
    $('#discipline-form-error').textContent = error.message;
  }
}

async function removeDiscipline(id) {
  if (!confirm('Снять это взыскание?')) return;
  try {
    await api(`/api/discipline/${id}`, { method: 'DELETE' });
    $('#profile-dialog').close();
    await loadUsers();
    await loadDashboard();
    toast('Взыскание снято.');
  } catch (error) {
    toast(error.message);
  }
}

function openAvatarDialog(id = state.me.id) {
  $('#avatar-form').reset();
  $('#avatar-form').elements.userId.value = id;
  $('#avatar-form-error').textContent = '';
  $('#avatar-dialog').showModal();
}

async function submitAvatar(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const userId = form.elements.userId.value;
  const data = new FormData();
  data.append('avatar', form.elements.avatar.files[0]);
  try {
    await api(`/api/users/${userId}/avatar`, { method: 'POST', body: data });
    $('#avatar-dialog').close();
    await loadDashboard();
    await loadUsers();
    toast('Фотография обновлена.');
  } catch (error) {
    $('#avatar-form-error').textContent = error.message;
  }
}

async function unlinkIntegration(provider) {
  if (!confirm(`Отвязать ${provider === 'discord' ? 'Discord' : 'Steam'}?`)) return;
  try {
    await api(`/api/integrations/${provider}/unlink`, { method: 'POST' });
    await loadDashboard();
    toast('Интеграция отключена.');
  } catch (error) {
    toast(error.message);
  }
}

function conversationTitle(conversation) {
  if (conversation.type === 'group') return conversation.title;
  return conversation.members.find(member => member.id !== state.me.id)?.nickname || 'Личный канал';
}

function renderConversations() {
  $('#conversation-list').innerHTML = state.conversations.map(conversation => `
    <button class="conversation-item ${state.activeConversationId === conversation.id ? 'active' : ''}" data-id="${conversation.id}" type="button">
      <strong>${escapeHtml(conversationTitle(conversation))}</strong>
      <span>${escapeHtml(conversation.last_message || (conversation.type === 'group' ? `${conversation.members.length} участников` : 'Канал создан'))}</span>
    </button>
  `).join('') || '<p class="muted small">Каналов пока нет.</p>';
  $$('.conversation-item').forEach(button => button.addEventListener('click', () => openConversation(Number(button.dataset.id))));
}

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations;
  renderConversations();
}

async function openConversation(id) {
  state.activeConversationId = id;
  renderConversations();
  const conversation = state.conversations.find(item => item.id === id);
  if (!conversation) return;
  $('#chat-empty').classList.add('hidden');
  $('#chat-active').classList.remove('hidden');
  $('#chat-header').innerHTML = `<strong>${escapeHtml(conversationTitle(conversation))}</strong><span>${conversation.type === 'group' ? `${conversation.members.length} участников` : 'Защищённый личный канал'}</span>`;
  const data = await api(`/api/conversations/${id}/messages`);
  renderMessages(data.messages);
  state.socket?.emit('join_conversation', id);
}

function renderMessages(messages) {
  const container = $('#messages');
  container.innerHTML = messages.map(messageHtml).join('');
  container.scrollTop = container.scrollHeight;
}

function messageHtml(message) {
  const own = message.sender_id === state.me.id;
  return `<div class="message ${own ? 'own' : ''}"><div class="message-head"><b>${escapeHtml(message.nickname)}</b><span>${formatDate(message.created_at)}</span></div><p>${escapeHtml(message.body)}</p></div>`;
}

function openChatDialog() {
  $('#chat-form').reset();
  $('#chat-form-error').textContent = '';
  $('#group-title-label').classList.add('hidden');
  $('#member-picker').innerHTML = state.users.filter(user => user.id !== state.me.id).map(user => `
    <label class="member-option"><input type="checkbox" name="memberIds" value="${user.id}">${avatarHtml(user, 'mini-avatar')}<span>${escapeHtml(user.nickname)} · L${user.accessLevel}</span></label>
  `).join('');
  $('#chat-dialog').showModal();
}

async function submitChat(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.elements.type.value;
  const memberIds = [...form.querySelectorAll('input[name="memberIds"]:checked')].map(input => Number(input.value));
  if (type === 'direct' && memberIds.length !== 1) {
    $('#chat-form-error').textContent = 'Для личного чата выберите одного сотрудника.';
    return;
  }
  try {
    const data = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ type, title: form.elements.title.value, memberIds }) });
    $('#chat-dialog').close();
    await loadConversations();
    await openConversation(data.id);
  } catch (error) {
    $('#chat-form-error').textContent = error.message;
  }
}

async function loadAudit() {
  try {
    const data = await api('/api/audit');
    const names = {
      user_registered: 'Создано личное досье', user_created: 'Создан аккаунт', user_updated: 'Изменено досье', user_deleted: 'Удалён аккаунт',
      avatar_updated: 'Обновлена фотография', discord_linked: 'Привязан Discord', discord_unlinked: 'Отвязан Discord', steam_linked: 'Привязан Steam', steam_unlinked: 'Отвязан Steam',
      discipline_issued: 'Выдано взыскание', discipline_removed: 'Снято взыскание', event_started: 'Ивент начат', event_completed: 'Ивент завершён', event_cancelled: 'Ивент отменён',
      event_points_adjusted: 'Скорректированы баллы'
    };
    $('#audit-list').innerHTML = data.logs.map(log => `
      <div class="audit-entry"><time>${formatDate(log.created_at)}</time><div><b>${escapeHtml(names[log.action] || log.action)}</b><small>${escapeHtml(log.actor_name || 'Система')} → ${escapeHtml(log.target_name || '—')}</small></div></div>
    `).join('') || '<p class="muted">Записей нет.</p>';
  } catch (error) {
    $('#audit-list').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

function connectSocket() {
  if (state.socket) return;
  state.socket = io();
  state.socket.on('new_message', ({ conversationId, message }) => {
    if (state.activeConversationId === conversationId) {
      $('#messages').insertAdjacentHTML('beforeend', messageHtml(message));
      $('#messages').scrollTop = $('#messages').scrollHeight;
    }
    loadConversations();
  });
}

async function enterApp(user) {
  state.me = user;
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  applyPermissions();
  renderCurrentUser();
  renderEventRules();
  await Promise.all([loadDashboard(), loadUsers()]);
  connectSocket();
  const requested = location.hash.replace('#', '') || 'profile';
  setView(requested, false);
  const integration = new URLSearchParams(location.search).get('integration');
  if (integration) {
    const messages = {
      'discord-ok': 'Discord успешно привязан.', 'discord-error': 'Не удалось привязать Discord.',
      'steam-ok': 'Steam успешно привязан.', 'steam-error': 'Не удалось привязать Steam.'
    };
    toast(messages[integration] || 'Интеграция обработана.');
    history.replaceState(null, '', `${location.pathname}#profile`);
  }
}

function showAuthForm(mode) {
  const login = mode === 'login';
  $('#login-form').classList.toggle('hidden', !login);
  $('#register-form').classList.toggle('hidden', login);
  $('#show-login').classList.toggle('active', login);
  $('#show-register').classList.toggle('active', !login);
}

async function boot() {
  try {
    state.config = await api('/api/config');
    $('#show-register').classList.toggle('hidden', !state.config.allowRegistration);
    $('#registration-code-label').classList.toggle('hidden', !state.config.registrationCodeRequired);
  } catch {}
  try {
    const data = await api('/api/me');
    await enterApp(data.user);
  } catch {
    $('#login-screen').classList.remove('hidden');
  }
}

$('#show-login').addEventListener('click', () => showAuthForm('login'));
$('#show-register').addEventListener('click', () => showAuthForm('register'));
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').textContent = '';
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
    await enterApp(data.user);
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});
$('#register-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#register-error').textContent = '';
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(values) });
    await enterApp(data.user);
  } catch (error) {
    $('#register-error').textContent = error.message;
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});
$('#mobile-menu-btn').addEventListener('click', () => $('#main-nav').classList.toggle('open'));
$$('[data-view]').forEach(button => button.addEventListener('click', event => {
  event.preventDefault();
  setView(button.dataset.view);
}));
$('#refresh-events-btn').addEventListener('click', loadEvents);
$('#staff-search').addEventListener('input', renderStaff);
$('#staff-filter').addEventListener('change', renderStaff);
$('#add-user-btn').addEventListener('click', () => openUserDialog());
$('#user-form').addEventListener('submit', submitUser);
$('#delete-user-btn').addEventListener('click', deleteUser);
$('#change-avatar-btn').addEventListener('click', () => openAvatarDialog());
$('#avatar-form').addEventListener('submit', submitAvatar);
$('#close-profile-dialog').addEventListener('click', () => $('#profile-dialog').close());
$('#discipline-form').addEventListener('submit', submitDiscipline);
$('#new-chat-btn').addEventListener('click', openChatDialog);
$('#chat-type').addEventListener('change', event => {
  $('#group-title-label').classList.toggle('hidden', event.target.value !== 'group');
  $$('#member-picker input').forEach(input => { input.checked = false; });
});
$('#member-picker').addEventListener('change', event => {
  if ($('#chat-type').value === 'direct' && event.target.checked) {
    $$('#member-picker input').forEach(input => { if (input !== event.target) input.checked = false; });
  }
});
$('#chat-form').addEventListener('submit', submitChat);
$('#message-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#message-input');
  const body = input.value.trim();
  if (!body || !state.activeConversationId) return;
  state.socket.emit('send_message', { conversationId: state.activeConversationId, body }, response => {
    if (response?.error) toast(response.error);
    else input.value = '';
  });
});
$('#message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#message-form').requestSubmit();
  }
});
window.addEventListener('hashchange', () => {
  if (state.me) setView(location.hash.replace('#', '') || 'profile', false);
});

boot();
