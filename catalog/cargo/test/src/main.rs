fn greeting(name: &str) -> String {
    format!("hello {}", name)
}

fn main() {
    println!("{}", greeting("catalog"));
}

#[cfg(test)]
mod tests {
    use super::greeting;

    #[test]
    fn greets() {
        assert_eq!(greeting("rust"), "hello rust");
    }
}
