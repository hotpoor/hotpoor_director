from backend.knowledge.import_kb import markdown_files


def test_recursive_markdown_scan_ignores_hidden_dependencies_and_non_markdown(tmp_path):
    for name in ['a/one.md', 'a/b/two.MARKDOWN', 'node_modules/no.md', '.private/secret.md', 'a/.hidden.md', 'a/file.pdf']:
        file = tmp_path / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('fixture', encoding='utf-8')
    files, skipped = markdown_files(tmp_path)
    assert {p.relative_to(tmp_path).as_posix() for p in files} == {'a/one.md', 'a/b/two.MARKDOWN'}
    assert skipped == 2
