export interface KnowledgeSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly aliases?: readonly string[];
}

export interface KnowledgePage {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly KnowledgeSection[];
}

export interface KnowledgeSearch {
  readonly version: string;
  readonly matches: readonly {
    readonly id: string;
    readonly section: string;
    readonly title: string;
    readonly excerpt: string;
  }[];
}

export interface KnowledgeReading {
  readonly version: string;
  readonly id: string;
  readonly title: string;
  readonly sectionTitle: string | null;
  readonly outline: boolean;
  readonly text: string;
  readonly sections: readonly { readonly id: string; readonly title: string }[];
}
