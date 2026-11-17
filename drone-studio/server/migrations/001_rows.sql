-- Application state: accounts, sessions, documents, proposals, activity. One row per record, revisioned.
create table if not exists lucidity_rows (
  collection text not null, account text not null, id text not null,
  rev integer not null, data jsonb not null, lookup text, updated_at bigint not null,
  primary key (collection, account, id)
);
create index if not exists lucidity_rows_recent on lucidity_rows (collection, account, updated_at desc);
create unique index if not exists lucidity_rows_lookup on lucidity_rows (collection, lookup) where lookup is not null;
create index if not exists lucidity_rows_owner on lucidity_rows ((data->>'account')) where data ? 'account';
