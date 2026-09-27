CREATE TABLE IF NOT EXISTS index_search (
    word text NOT NULL,
    block_id uuid NOT NULL,
    PRIMARY KEY (word, block_id)
);
CREATE INDEX IF NOT EXISTS index_search_word_idx ON index_search (word);
CREATE INDEX IF NOT EXISTS index_search_block_idx ON index_search (block_id);
