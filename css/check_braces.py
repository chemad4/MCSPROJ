
with open('/Users/louiseadrianvnonog/XFitTrack/MCSPROJ/css/styles.css', 'r') as f:
    lines = f.readlines()

stack = []
for i, line in enumerate(lines):
    for char in line:
        if char == '{':
            stack.append(i + 1)
        elif char == '}':
            if not stack:
                print(f"Extra '}}' found on line {i + 1}")
            else:
                stack.pop()

if stack:
    for line_num in stack:
        print(f"Unclosed '{{' starting on line {line_num}")
