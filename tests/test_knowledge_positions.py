import uuid
from backend.knowledge.positions import source_lines, document_positions, word_id


def test_markdown_lines_pages_unicode_and_repeated_words():
    book = uuid.uuid4()
    text = '## 第 12 页\r\n\r\n😀研究，研究。\n![图](images/a.png)\n'
    lines = list(source_lines(book,text))
    assert [x['line_number'] for x in lines] == [1,2,3,4]
    assert lines[2]['page'] == 12
    assert lines[3]['kind'] == 'image'
    assert lines[2]['paragraph_id'] == lines[3]['paragraph_id']
    for line in lines:
        assert text[line['char_start']:line['char_end']] == line['text']
        assert line['line_id'].startswith(str(book)+'_')
    rows = [r for r in document_positions(book,text) if r[1]=='研究']
    import json
    assert len(rows)==1
    assert json.loads(rows[0][8]) == [{'start':1,'end':3},{'start':4,'end':6}]
    assert rows[0][4] == 3
    assert rows[0][0] == word_id('研究')


def test_ids_repeat_and_unknown_pages_stay_unknown():
    book = uuid.uuid4()
    lines = list(source_lines(book,'same\n\nsame'))
    assert lines == list(source_lines(book,'same\n\nsame'))
    assert len({x['line_id'] for x in lines}) == 3
    assert all(x['page'] is None for x in lines)
    assert lines[0]['paragraph_id'] != lines[2]['paragraph_id']
