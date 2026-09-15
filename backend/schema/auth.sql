CREATE TABLE IF NOT EXISTS index_login (
    login varchar(254) PRIMARY KEY,
    user_id varchar(32) NOT NULL UNIQUE CHECK (user_id ~ '^[0-9a-f]{32}$'),
    createtime bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    updatetime bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    CONSTRAINT login_normalized CHECK (login = lower(btrim(login)) AND length(login) > 0)
);
CREATE OR REPLACE TRIGGER index_login_touch BEFORE UPDATE ON index_login
FOR EACH ROW EXECUTE FUNCTION director_touch_timestamp();

CREATE TABLE IF NOT EXISTS auth_credentials (
    user_id varchar(32) PRIMARY KEY REFERENCES index_login(user_id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    createtime bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    updatetime bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
);
CREATE OR REPLACE TRIGGER auth_credentials_touch BEFORE UPDATE ON auth_credentials
FOR EACH ROW EXECUTE FUNCTION director_touch_timestamp();

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash varchar(64) PRIMARY KEY,
    user_id varchar(32) NOT NULL REFERENCES index_login(user_id) ON DELETE CASCADE,
    expires_at bigint NOT NULL,
    createtime bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions(expires_at);

-- Durable decisions for atomic writes spanning both UUID shards.
CREATE TABLE IF NOT EXISTS index_entity_commits (
    transaction_id text PRIMARY KEY
);
