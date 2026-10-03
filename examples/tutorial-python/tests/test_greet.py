from greet import hello


def test_greets_by_name():
    assert hello("hammerkit") == "Hello, hammerkit!"
