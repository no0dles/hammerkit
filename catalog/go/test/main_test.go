package main

import "testing"

func TestGreeting(t *testing.T) {
	if got := Greeting("go"); got != "hello go" {
		t.Fatalf("got %q", got)
	}
}
