pub fn hello(name: &str) -> String {
    format!("Hello, {name}!")
}

#[cfg(test)]
mod tests {
    use super::hello;
    use pretty_assertions::assert_eq;

    #[test]
    fn greets_by_name() {
        assert_eq!(hello("hammerkit"), "Hello, hammerkit!");
    }
}
