import unittest

from intervals import merge_intervals


class MergeIntervalsTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(merge_intervals([]), [])

    def test_unsorted_overlap(self):
        self.assertEqual(
            merge_intervals([(5, 9), (1, 4), (3, 7), (2, 2)]), [(1, 9)]
        )

    def test_adjacency(self):
        self.assertEqual(merge_intervals([(3, 4), (1, 2), (5, 5)]), [(1, 5)])

    def test_separated_ranges(self):
        self.assertEqual(
            merge_intervals([(8, 10), (-4, -2), (1, 3)]),
            [(-4, -2), (1, 3), (8, 10)],
        )

    def test_reversed_endpoints(self):
        with self.assertRaises(ValueError):
            merge_intervals([(1, 2), (5, 3)])

    def test_input_unchanged(self):
        intervals = [[5, 8], [1, 3], [3, 6]]
        original = [interval[:] for interval in intervals]
        self.assertEqual(merge_intervals(intervals), [(1, 8)])
        self.assertEqual(intervals, original)


if __name__ == "__main__":
    unittest.main()
