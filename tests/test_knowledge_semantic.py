import unittest
from backend.knowledge.semantic import fuse, passages

class HybridTests(unittest.TestCase):
    def test_union_preserves_both_single_channel_results(self):
        rows=fuse([{'block_id':'a','score':3},{'block_id':'b','score':1}],
                  [{'block_id':'b','semantic_score':.8,'passages':[]},{'block_id':'c','semantic_score':.7,'passages':[]}])
        self.assertEqual({x['block_id'] for x in rows},{'a','b','c'})
        self.assertEqual(rows[0]['block_id'],'b')
        by_id={x['block_id']:x for x in rows}
        self.assertEqual(by_id['a']['channels'],['lexical'])
        self.assertEqual(by_id['c']['channels'],['semantic'])
        self.assertEqual(by_id['b']['channels'],['lexical','semantic'])

    def test_duplicate_does_not_inflate_rank_or_score(self):
        one={'block_id':'a','score':1}
        self.assertEqual(fuse([one,one],[]),fuse([one],[]))

    def test_full_document_coverage_including_late_text_and_long_lines(self):
        lines=[{'text':'前言'*2500},{'text':''},{'text':'corruption '*900},{'text':'文末独有证据'}]
        body='\n'.join(x['text'] for x in lines)
        chunks=list(passages(lines))
        covered=set()
        for chunk in chunks:
            a,b=chunk['char_start'],chunk['char_end']
            self.assertEqual(chunk['text'],body[a:b]);covered.update(range(a,b))
            self.assertGreaterEqual(chunk['line_start'],1)
            self.assertLessEqual(chunk['line_end'],len(lines))
        self.assertEqual(len(covered),len(body))
        self.assertIn('文末独有证据',chunks[-1]['text'])
        self.assertEqual(chunks[-1]['line_end'],4)

if __name__=='__main__':unittest.main()
