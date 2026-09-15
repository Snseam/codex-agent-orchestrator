const STORE_KEY = 'cao.monitor.conversationFilter';
const UNLINKED_VALUE = '__unlinked__';

const COPY = {
  en: {
    landmark: 'Conversation scope',
    project: 'Project',
    conversation: 'Conversation',
    choose: 'Conversation',
    current: 'Current',
    noConversations: 'No conversations in this scope',
    currentMissing: 'The current conversation is outside this snapshot.',
    unlinked: 'Unlinked agents',
    unlinkedHelp: 'Show agents without a verified conversation.',
    unknownTitle: 'Codex',
    count: count => `${count} agent${count === 1 ? '' : 's'}`,
  },
  zh: {
    landmark: '对话范围',
    project: '项目',
    conversation: '对话',
    choose: '对话',
    current: '当前',
    noConversations: '当前范围内没有对话',
    currentMissing: '当前对话不在此快照范围内。',
    unlinked: '未关联 Agent',
    unlinkedHelp: '显示没有可靠对话归属的 Agent。',
    unknownTitle: 'Codex',
    count: count => `${count} 个 Agent`,
  },
};

function copy(lang) {
  return COPY[lang] || COPY.en;
}

function safeString(value) {
  return typeof value === 'string' && value ? value : null;
}

export function shortId(id) {
  const value = safeString(id) || 'unknown';
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function conversationTitle(conversation, lang = 'en') {
  const title = safeString(conversation?.title);
  if (title) return title;
  return `${copy(lang).unknownTitle} ${shortId(conversation?.id)}`;
}

export function normalizeConversations(snapshot, lang = 'en') {
  const conversations = Array.isArray(snapshot?.conversations) ? snapshot.conversations : [];
  return conversations
    .filter(item => safeString(item?.id))
    .map(item => ({
      id: item.id,
      title: conversationTitle(item, lang),
      rootNodeId: safeString(item.rootNodeId),
      projectIds: Array.isArray(item.projectIds) ? item.projectIds.filter(Boolean) : [],
      status: safeString(item.status) || 'unknown',
      updatedAt: safeString(item.updatedAt),
      agentCount: Number.isSafeInteger(item.agentCount) && item.agentCount >= 0 ? item.agentCount : 0,
      current: item.current === true || item.id === snapshot?.currentConversationId,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.title.localeCompare(b.title));
}

export function resolveConversationSelection({ snapshot, previous, userSelected = false, lang = 'en' } = {}) {
  const conversations = normalizeConversations(snapshot, lang);
  const ids = new Set(conversations.map(item => item.id));
  const currentId = safeString(snapshot?.currentConversationId);
  const previousId = previous?.unlinked ? null : safeString(previous?.conversationId);

  if (previous?.view !== 'conversation') {
    return { view: 'project', conversationId: null, unlinked: false, currentMissing: false, conversations };
  }
  if (snapshot == null) {
    return { view: 'conversation', conversationId: previousId, unlinked: previous?.unlinked === true, currentMissing: false, conversations };
  }
  if (previous?.unlinked) {
    return { view: 'conversation', conversationId: null, unlinked: true, currentMissing: false, conversations };
  }
  if (previousId && ids.has(previousId)) {
    return { view: 'conversation', conversationId: previousId, unlinked: false, currentMissing: false, conversations };
  }
  if (!userSelected && currentId && ids.has(currentId)) {
    return { view: 'conversation', conversationId: currentId, unlinked: false, currentMissing: false, conversations };
  }
  const fallback = conversations[0]?.id || null;
  if (!fallback) {
    return { view: 'conversation', conversationId: null, unlinked: true, currentMissing: false, conversations };
  }
  return {
    view: 'conversation',
    conversationId: fallback,
    unlinked: false,
    currentMissing: Boolean(currentId && !ids.has(currentId)),
    conversations,
  };
}

function readStored(storage) {
  try {
    const raw = storage?.getItem?.(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.view === 'conversation') {
      return { view: 'conversation', conversationId: safeString(parsed.conversationId), unlinked: parsed.unlinked === true };
    }
  } catch {}
  return { view: 'project', conversationId: null, unlinked: false };
}

function writeStored(storage, filter) {
  try { storage?.setItem?.(STORE_KEY, JSON.stringify(filter)); } catch {}
}

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createConversationView({ container, onChange = () => {}, storage = globalThis.localStorage } = {}) {
  if (!container?.ownerDocument) throw new Error('createConversationView requires a DOM container');
  const document = container.ownerDocument;
  let lang = 'en';
  let snapshot = null;
  let userSelected = false;
  let filter = readStored(storage) || { view: 'project', conversationId: null, unlinked: false };

  const root = el(document, 'section', 'cao-conv', '');
  root.setAttribute('aria-label', copy(lang).landmark);
  const switcher = el(document, 'div', 'cao-conv__switch');
  switcher.setAttribute('role', 'group');
  const projectButton = el(document, 'button', 'cao-conv__tab');
  projectButton.type = 'button';
  const conversationButton = el(document, 'button', 'cao-conv__tab');
  conversationButton.type = 'button';

  const controls = el(document, 'div', 'cao-conv__controls');
  const label = el(document, 'label', 'cao-conv__field');
  const labelText = el(document, 'span', 'cao-conv__label');
  const select = el(document, 'select', 'cao-conv__select');
  const note = el(document, 'p', 'cao-conv__note');

  label.append(labelText, select);
  controls.append(label, note);
  switcher.append(projectButton, conversationButton);
  root.append(switcher, controls);
  container.textContent = '';
  container.append(root);

  function currentState() {
    return resolveConversationSelection({ snapshot, previous: filter, userSelected, lang });
  }

  function publicFilter() {
    const state = currentState();
    return {
      view: state.view,
      conversationId: state.view === 'conversation' && !state.unlinked ? state.conversationId : null,
      unlinked: state.view === 'conversation' ? state.unlinked : false,
    };
  }

  function render() {
    const t = copy(lang);
    const state = currentState();
    filter = { view: state.view, conversationId: state.conversationId, unlinked: state.unlinked };
    root.setAttribute('aria-label', t.landmark);
    projectButton.textContent = t.project;
    conversationButton.textContent = t.conversation;
    projectButton.setAttribute('aria-pressed', String(state.view === 'project'));
    conversationButton.setAttribute('aria-pressed', String(state.view === 'conversation'));
    labelText.textContent = t.choose;
    controls.hidden = state.view !== 'conversation';
    select.textContent = '';

    const unlinked = document.createElement('option');
    unlinked.value = UNLINKED_VALUE;
    unlinked.textContent = t.unlinked;
    select.append(unlinked);
    for (const conversation of state.conversations) {
      const option = document.createElement('option');
      option.value = conversation.id;
      option.textContent = `${conversation.title}${conversation.current ? ` · ${t.current}` : ''} · ${t.count(conversation.agentCount)}`;
      select.append(option);
    }
    select.disabled = state.conversations.length === 0 && !state.unlinked;
    select.value = state.unlinked ? UNLINKED_VALUE : state.conversationId || UNLINKED_VALUE;

    if (state.currentMissing) note.textContent = t.currentMissing;
    else if (state.unlinked) note.textContent = t.unlinkedHelp;
    else if (state.conversations.length === 0) note.textContent = t.noConversations;
    else note.textContent = '';
  }

  function commit(next) {
    userSelected = true;
    filter = next;
    writeStored(storage, publicFilter());
    render();
    onChange(publicFilter());
  }

  projectButton.addEventListener('click', () => commit({ view: 'project', conversationId: null, unlinked: false }));
  conversationButton.addEventListener('click', () => {
    const state = resolveConversationSelection({ snapshot, previous: { ...filter, view: 'conversation' }, userSelected, lang });
    commit({ view: 'conversation', conversationId: state.conversationId, unlinked: state.unlinked });
  });
  select.addEventListener('change', () => {
    commit({ view: 'conversation', conversationId: select.value === UNLINKED_VALUE ? null : select.value, unlinked: select.value === UNLINKED_VALUE });
  });

  render();
  return {
    setSnapshot(nextSnapshot) {
      snapshot = nextSnapshot && typeof nextSnapshot === 'object' ? nextSnapshot : null;
      render();
    },
    setLanguage(nextLang) {
      lang = nextLang === 'zh' ? 'zh' : 'en';
      render();
    },
    getFilter: publicFilter,
    destroy() {
      root.remove();
    },
  };
}
