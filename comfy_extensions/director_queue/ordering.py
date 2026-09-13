"""Reorder selected pending slots without removing or resubmitting prompts."""
import heapq


def reorder_pending(queue, expected, order):
    with queue.mutex:
        current = sorted(queue.queue)
        if [item[1] for item in current] != expected:
            raise ValueError('队列已变化，请刷新后重试')
        if len(order) != len(set(order)) or not set(order) <= set(expected):
            raise ValueError('待排序任务不正确')
        if len({item[0] for item in current}) != len(current):
            raise ValueError('队列优先级冲突，暂不能排序')
        selected = {item[1]: item for item in current if item[1] in order}
        replacements = iter(order)
        result = []
        for item in current:
            if item[1] in selected:
                source = selected[next(replacements)]
                item = (item[0], *source[1:])
            result.append(item)
        heapq.heapify(result)
        queue.queue = result
        queue.server.queue_updated()

