package dev.hammerkit.greet;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class GreetTest {
    @Test
    void greetsByName() {
        assertEquals("Hello, hammerkit!", Greet.hello("hammerkit"));
    }
}
