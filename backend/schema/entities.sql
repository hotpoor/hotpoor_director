CREATE TABLE IF NOT EXISTS entities (
    block_id varchar(32) PRIMARY KEY DEFAULT replace(gen_random_uuid()::text, '-', ''),
    body jsonb NOT NULL DEFAULT '{}'::jsonb,
    createtime bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    updatetime bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    CONSTRAINT entities_block_id_hex CHECK (block_id ~ '^[0-9a-f]{32}$')
);
CREATE INDEX IF NOT EXISTS entities_body_gin ON entities USING gin (body);
CREATE INDEX IF NOT EXISTS entities_updatetime_idx ON entities (updatetime);
CREATE OR REPLACE TRIGGER entities_touch BEFORE UPDATE ON entities
FOR EACH ROW EXECUTE FUNCTION director_touch_timestamp();
