import TestRepoBackend from './test-repo/implementation';
import GitHubBackend from './github/implementation';
import NetlifyGitBackend from './netlify-git/implementation';
import { resolveFormat } from '../formats/formats';
import { createEntry } from '../valueObjects/Entry';
import Collection from '../valueObjects/Collection';

class LocalStorageAuthStore {
  storageKey = 'nf-cms-user';

  retrieve() {
    const data = window.localStorage.getItem(this.storageKey);
    return data && JSON.parse(data);
  }

  store(userData) {
    window.localStorage.setItem(this.storageKey, JSON.stringify(userData));
  }
}

const slugFormatter = (template, entryData) => {
  const date = new Date();
  return template.replace(/\{\{([^\}]+)\}\}/g, (_, name) => {
    switch (name) {
      case 'year':
        return date.getFullYear();
      case 'month':
        return (`0${ date.getMonth() + 1 }`).slice(-2);
      case 'day':
        return (`0${ date.getDate() }`).slice(-2);
      case 'slug':
        const identifier = entryData.get('title', entryData.get('path'));
        return identifier.trim().toLowerCase().replace(/[^a-z0-9\.\-\_]+/gi, '-');
      default:
        return entryData.get(name);
    }
  });
};

class Backend {
  constructor(implementation, authStore = null) {
    this.implementation = implementation;
    this.authStore = authStore;
    if (this.implementation === null) {
      throw new Error('Cannot instantiate a Backend with no implementation');
    }
  }

  currentUser() {
    if (this.user) { return this.user; }
    const stored = this.authStore && this.authStore.retrieve();
    if (stored) {
      this.implementation.setUser(stored);
      return stored;
    }
  }

  authComponent() {
    return this.implementation.authComponent();
  }

  authenticate(credentials) {
    return this.implementation.authenticate(credentials).then((user) => {
      if (this.authStore) { this.authStore.store(user); }
      return user;
    });
  }

  listEntries(collection) {
    const collectionModel = new Collection(collection);
    const listMethod = this.implementation[collectionModel.listMethod()];
    return listMethod.call(this.implementation, collection)
      .then(loadedEntries => (
        loadedEntries.map(loadedEntry => createEntry(
          collection.get('name'),
          collectionModel.entrySlug(loadedEntry.file.path),
          loadedEntry.file.path,
          { raw: loadedEntry.data, label: loadedEntry.file.label }
        ))
      ))
      .then(entries => (
        {
          entries: entries.map(this.entryWithFormat(collection)),
        }
      ));
  }

  getEntry(collection, slug) {
    return this.implementation.getEntry(collection, slug, new Collection(collection).entryPath(slug))
      .then(loadedEntry => this.entryWithFormat(collection, slug)(createEntry(
        collection.get('name'),
        slug,
        loadedEntry.file.path,
        { raw: loadedEntry.data, label: loadedEntry.file.label }
      ))
    );
  }

  newEntry(collection) {
    return createEntry(collection.get('name'));
  }

  entryWithFormat(collectionOrEntity) {
    return (entry) => {
      const format = resolveFormat(collectionOrEntity, entry);
      if (entry && entry.raw) {
        return Object.assign(entry, { data: format && format.fromFile(entry.raw) });
      }
      return format.fromFile(entry);
    };
  }

  unpublishedEntries(page, perPage) {
    return this.implementation.unpublishedEntries(page, perPage)
    .then(loadedEntries => (
      loadedEntries.map((loadedEntry) => {
        const entry = createEntry('draft', loadedEntry.slug, loadedEntry.file.path, { raw: loadedEntry.data })
        entry.metaData = loadedEntry.metaData;
        return entry;
      })
    ))
    .then((entries) => {
      const filteredEntries = entries.filter(entry => entry !== null);
      return {
        pagination: 0,
        entries: filteredEntries.map(this.entryWithFormat('editorialWorkflow')),
      };
    });
  }

  unpublishedEntry(collection, slug) {
    return this.implementation.unpublishedEntry(collection, slug)
    .then(loadedEntry => this.entryWithFormat(collection, slug)(createEntry(
      collection.get('name'),
      slug,
      loadedEntry.file.path,
      { raw: loadedEntry.data }
    )));
  }

  persistEntry(config, collection, entryDraft, MediaFiles, options) {
    const collectionModel = new Collection(collection);
    const newEntry = entryDraft.getIn(['entry', 'newRecord']) || false;

    const parsedData = {
      title: entryDraft.getIn(['entry', 'data', 'title'], 'No Title'),
      description: entryDraft.getIn(['entry', 'data', 'description'], 'No Description'),
    };

    const entryData = entryDraft.getIn(['entry', 'data']).toJS();
    let entryObj;
    if (newEntry) {
      if (!collectionModel.allowNewEntries()) {
        throw (new Error('Not allowed to create new entries in this collection'));
      }
      const slug = slugFormatter(collection.get('slug'), entryDraft.getIn(['entry', 'data']));
      const path = collectionModel.entryPath(slug);
      entryObj = {
        path,
        slug,
        raw: this.entryToRaw(collection, Object.assign({ path }, entryData)),
      };
    } else {
      const path = entryDraft.getIn(['entry', 'path']);
      entryObj = {
        path,
        slug: entryDraft.getIn(['entry', 'slug']),
        raw: this.entryToRaw(collection, Object.assign({ path }, entryData)),
      };
    }

    const commitMessage = `${ (newEntry ? 'Created ' : 'Updated ') +
          collection.get('label') } “${
          entryDraft.getIn(['entry', 'data', 'title']) }”`;

    const mode = config.get('publish_mode');

    const collectionName = collection.get('name');

    return this.implementation.persistEntry(entryObj, MediaFiles, {
      newEntry, parsedData, commitMessage, collectionName, mode, ...options,
    });
  }

  persistUnpublishedEntry(config, collection, entryDraft, MediaFiles) {
    return this.persistEntry(config, collection, entryDraft, MediaFiles, { unpublished: true });
  }

  updateUnpublishedEntryStatus(collection, slug, newStatus) {
    return this.implementation.updateUnpublishedEntryStatus(collection, slug, newStatus);
  }

  publishUnpublishedEntry(collection, slug, status) {
    return this.implementation.publishUnpublishedEntry(collection, slug, status);
  }


  entryToRaw(collection, entry) {
    const format = resolveFormat(collection, entry);
    return format && format.toFile(entry);
  }
}

export function resolveBackend(config) {
  const name = config.getIn(['backend', 'name']);
  if (name == null) {
    throw new Error('No backend defined in configuration');
  }

  const authStore = new LocalStorageAuthStore();

  switch (name) {
    case 'test-repo':
      return new Backend(new TestRepoBackend(config), authStore);
    case 'github':
      return new Backend(new GitHubBackend(config), authStore);
    case 'netlify-git':
      return new Backend(new NetlifyGitBackend(config), authStore);
    default:
      throw new Error(`Backend not found: ${ name }`);
  }
}

export const currentBackend = (function () {
  let backend = null;

  return (config) => {
    if (backend) { return backend; }
    if (config.get('backend')) {
      return backend = resolveBackend(config);
    }
  };
}());