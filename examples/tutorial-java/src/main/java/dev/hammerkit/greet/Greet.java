package dev.hammerkit.greet;

public class Greet {
    public static String hello(String name) {
        return "Hello, " + name + "!";
    }

    public static void main(String[] args) {
        System.out.println(hello(args.length > 0 ? args[0] : "world"));
    }
}
