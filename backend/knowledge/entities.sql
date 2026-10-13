CREATE TABLE IF NOT EXISTS entities (
    block_id uuid PRIMARY KEY,
    body jsonb NOT NULL,
    createtime bigint NOT NULL,
    updatetime bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS entities_kind_idx ON entities ((body->>'kind'));
CREATE INDEX IF NOT EXISTS entities_path_idx ON entities ((body->>'path'));
CREATE INDEX IF NOT EXISTS entities_updatetime_idx ON entities (updatetime);
