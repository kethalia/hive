"""Utilities for closed integer intervals."""


def merge_intervals(intervals):
    """Return sorted intervals merged across overlaps and adjacency.

    Raise ValueError if any interval's start exceeds its end. The input is
    never modified.
    """
    ordered = []
    for start, end in intervals:
        if start > end:
            raise ValueError("interval start must not exceed its end")
        ordered.append((start, end))
    ordered.sort()

    merged = []
    for start, end in ordered:
        if merged and start <= merged[-1][1] + 1:
            previous_start, previous_end = merged[-1]
            merged[-1] = (previous_start, max(previous_end, end))
        else:
            merged.append((start, end))
    return merged
