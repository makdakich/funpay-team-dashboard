class MockNode {
  childNodes: any[] = [];
  appendChild(child: any) {
    this.childNodes.push(child);
    return child;
  }
}

class MockText extends MockNode {
  textContent: string;
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

class MockElement extends MockNode {
  tagName: string;
  private _className = '';
  style: Record<string, string> = {};
  title = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  classList: {
    _classes: Set<string>;
    add: (...classes: string[]) => void;
    remove: (...classes: string[]) => void;
    toggle: (cls: string, force?: boolean) => boolean;
    contains: (cls: string) => boolean;
  };

  constructor(tagName: string) {
    super();
    this.tagName = tagName;
    const classes = new Set<string>();
    this.classList = {
      _classes: classes,
      add: (...cls: string[]) => {
        cls.forEach(c => classes.add(c));
        this._className = Array.from(classes).join(' ');
      },
      remove: (...cls: string[]) => {
        cls.forEach(c => classes.delete(c));
        this._className = Array.from(classes).join(' ');
      },
      toggle: (cls: string, force?: boolean) => {
        const next = force !== undefined ? force : !classes.has(cls);
        if (next) classes.add(cls);
        else classes.delete(cls);
        this._className = Array.from(classes).join(' ');
        return next;
      },
      contains: (cls: string) => classes.has(cls)
    };
  }

  get className(): string {
    return this._className;
  }

  set className(val: string) {
    this._className = val;
    this.classList._classes.clear();
    val.split(/\s+/).filter(Boolean).forEach(c => this.classList._classes.add(c));
  }

  setAttribute(k: string, v: string) {
    this.attributes[k] = v;
  }

  getAttribute(k: string) {
    return this.attributes[k] ?? null;
  }

  append(...children: any[]) {
    for (const c of children) {
      if (c === null || c === undefined) continue;
      this.appendChild(typeof c === 'string' ? new MockText(c) : c);
    }
  }

  replaceChildren(...children: any[]) {
    this.childNodes = [];
    this.append(...children);
  }

  querySelector(sel: string): any {
    for (const child of this.childNodes) {
      if (child instanceof MockElement) {
        if (sel.startsWith('.') && child.classList.contains(sel.slice(1))) return child;
        if (sel === child.tagName.toLowerCase()) return child;
        const found = child.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(sel: string): any[] {
    const list: any[] = [];
    for (const child of this.childNodes) {
      if (child instanceof MockElement) {
        if (sel.startsWith('.') && child.classList.contains(sel.slice(1))) list.push(child);
        list.push(...child.querySelectorAll(sel));
      }
    }
    return list;
  }

  addEventListener(_event: string, _fn: any) {}
  removeEventListener(_event: string, _fn: any) {}

  get textContent(): string {
    return this.childNodes.map(c => (c instanceof MockElement ? c.textContent : (c.textContent ?? ''))).join('');
  }

  set textContent(v: string) {
    this.childNodes = [new MockText(v)];
  }
}

export function setupMockDom() {
  const origDoc = (globalThis as any).document;
  const origWin = (globalThis as any).window;
  const origNode = (globalThis as any).Node;

  (globalThis as any).Node = MockNode;
  (globalThis as any).document = {
    createElement: (tag: string) => new MockElement(tag),
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockText(text)
  };
  (globalThis as any).window = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  return () => {
    (globalThis as any).document = origDoc;
    (globalThis as any).window = origWin;
    (globalThis as any).Node = origNode;
  };
}
