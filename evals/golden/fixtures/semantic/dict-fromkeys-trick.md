# `dict.fromkeys` for dedup

For a large iterable of hashable items where you want to preserve insertion order, `list(dict.fromkeys(items))` is faster and cleaner than building a set + comprehension. Works because Python dicts preserve insertion order since 3.7.

Skip it if items are unhashable.
