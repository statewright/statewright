// A Client keeps its button alive across Desktop focus/redraw events. The
// message is only an intent; connect.js validates its conversation and revision.
export default function DesktopAction(props, surface) {
  const { Button, Text } = surface.elements;
  return Button({ key: props.action, label: props.label,
    ...(props.color ? { children: [Text({ color: props.color, children: [props.label] })] } : {}),
    ...(props.primary ? { variant: 'primary' } : {}),
    onPress: () => surface.post({ action: props.action, revision: props.revision, conversation: props.conversation }),
  });
}
