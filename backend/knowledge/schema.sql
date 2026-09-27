CREATE TABLE IF NOT EXISTS index_search (
    word text NOT NULL,
    block_id uuid NOT NULL,
    PRIMARY KEY (word, block_id)
);
CREATE INDEX IF NOT EXISTS index_search_word_idx ON index_search (word);
CREATE INDEX IF NOT EXISTS index_search_block_idx ON index_search (block_id);

CREATE TABLE IF NOT EXISTS word_entities (
    block_id uuid PRIMARY KEY,
    word text NOT NULL UNIQUE,
    book_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS word_entities_books_idx ON word_entities USING gin(book_ids);
CREATE TABLE IF NOT EXISTS word_occurrences (
    term_id uuid NOT NULL REFERENCES word_entities(block_id),
    book_id uuid NOT NULL,
    line_id text NOT NULL,
    line_number integer NOT NULL,
    page integer,
    paragraph_id text,
    char_start integer NOT NULL,
    positions jsonb NOT NULL,
    kind text NOT NULL,
    PRIMARY KEY(term_id,book_id,line_id)
);
CREATE INDEX IF NOT EXISTS word_occurrences_book_idx ON word_occurrences(book_id,line_number);
CREATE TABLE IF NOT EXISTS positional_documents(book_id uuid PRIMARY KEY, version integer NOT NULL);
