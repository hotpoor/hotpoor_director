import io
import zipfile
import pytest
from tornado.web import HTTPError
from backend.dialogue_files import inspect_file, attachment_ids, image_part, pdf_part, MAX_FILE


def test_docx_extracts_paragraphs_without_running_content():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>剧本开场</w:t></w:r></w:p><w:p><w:r><w:t>雨夜</w:t></w:r></w:p></w:body></w:document>')
    mime, kind, text = inspect_file('剧本.docx', stream.getvalue())
    assert kind == 'text' and text == '剧本开场\n雨夜'


@pytest.mark.parametrize('encoding', ['utf-8-sig', 'utf-16', 'gb18030'])
def test_supported_text_encodings(encoding):
    assert inspect_file('brief.txt', '镜头说明'.encode(encoding))[2] == '镜头说明'


@pytest.mark.parametrize('name,raw', [('bad.exe', b'MZ123'), ('brief.txt', b'bad\x00content'), ('brief.txt', b'x'*80001), ('bad.pdf', b'not a pdf'), ('empty.txt', b''), ('large.txt', b'x'*(MAX_FILE+1)), ('invalid.docx', b'badzip')])
def test_invalid_or_oversized_file_rejected(name, raw):
    with pytest.raises(HTTPError): inspect_file(name, raw)


def test_native_image_and_pdf_shapes_match_each_protocol():
    assert image_part('data:image/png;base64,eA==', '/v1/responses')['type'] == 'input_image'
    assert image_part('data:image/png;base64,eA==', '/v1/chat/completions')['image_url']['url'].startswith('data:')
    assert pdf_part('brief.pdf', 'data:application/pdf;base64,eA==', '/v1/responses')['type'] == 'input_file'
    assert pdf_part('brief.pdf', 'data:application/pdf;base64,eA==', '/v1/chat/completions')['file']['filename'] == 'brief.pdf'


@pytest.mark.parametrize('ids', ['bad', ['bad'], ['a'*32]*2, [str(i).zfill(32) for i in range(6)]])
def test_attachment_reference_validation(ids):
    with pytest.raises(HTTPError): attachment_ids({'attachments': ids})
