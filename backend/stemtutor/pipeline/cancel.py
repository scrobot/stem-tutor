"""Cooperative cancellation of a running lesson.

``Cancelled`` derives from BaseException on purpose: stage code wraps library errors in
``except Exception`` handlers, which must not swallow a cancellation request.
"""


class Cancelled(BaseException):
    pass
