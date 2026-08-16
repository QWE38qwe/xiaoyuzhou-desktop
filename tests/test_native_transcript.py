import unittest

import native_host


class NativeTranscriptTests(unittest.TestCase):
    def test_normalizes_and_sorts_millisecond_segments(self):
        segments = native_host.normalize_segments(
            [
                {"begin_time": 2500, "end_time": 4000, "text": "第二句"},
                {"begin_time": 500, "end_time": 2000, "text": "第一句"},
            ],
            time_unit="milliseconds",
        )
        self.assertEqual([item["start"] for item in segments], [0.5, 2.5])
        self.assertEqual([item["text"] for item in segments], ["第一句", "第二句"])

    def test_markdown_uses_real_episode_links_and_timestamps(self):
        markdown = native_host.markdown_transcript(
            "测试单集",
            {
                "text": "第一句 第二句",
                "segments": [
                    {"start": 5, "end": 9, "text": "第一句"},
                    {"start": 65, "end": 70, "text": "第二句"},
                ],
            },
            episode_id="abc_123",
            episode_url="https://www.xiaoyuzhoufm.com/episode/abc_123",
        )
        self.assertIn(
            "> 原始单集：<https://www.xiaoyuzhoufm.com/episode/abc_123>",
            markdown,
        )
        self.assertIn(
            "[00:05](cosmos://page.cos/shownotes/abc_123?t=5"
            "&utm_source=xiaoyuzhou_desktop)",
            markdown,
        )
        self.assertLess(markdown.index("第一句"), markdown.index("第二句"))

    def test_plain_text_fallback_has_no_fake_timestamp(self):
        markdown = native_host.markdown_transcript(
            "无时间戳",
            {"text": "仅有纯文本", "segments": []},
        )
        self.assertIn("仅有纯文本", markdown)
        self.assertNotIn("cosmos://", markdown)


if __name__ == "__main__":
    unittest.main()
