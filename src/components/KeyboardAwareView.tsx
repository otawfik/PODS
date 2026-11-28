import React, { ReactNode, useEffect, useRef, useState } from 'react';
import {
  Keyboard, KeyboardEvent, LayoutAnimation, Platform, StyleProp, View, ViewStyle,
} from 'react-native';

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Called after the view has made room for the keyboard (e.g. scroll chat to the end). */
  onKeyboardShown?: () => void;
};

/**
 * Lifts its bottom content (e.g. a chat input bar) above the on-screen
 * keyboard. Unlike KeyboardAvoidingView it measures where it actually sits on
 * screen, so it works no matter what headers, banners or tab bars surround it.
 */
export default function KeyboardAwareView({ children, style, onKeyboardShown }: Props) {
  const ref = useRef<View>(null);
  const [inset, setInset] = useState(0);
  const onShownRef = useRef(onKeyboardShown);
  useEffect(() => {
    onShownRef.current = onKeyboardShown;
  }, [onKeyboardShown]);

  useEffect(() => {
    const animate = (e?: KeyboardEvent) => {
      if (Platform.OS === 'ios' && e && e.duration > 0) {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
    };

    const onShow = (e: KeyboardEvent) => {
      ref.current?.measureInWindow((_x, y, _w, height) => {
        // How far the keyboard's top edge reaches above this view's bottom edge.
        const overlap = Math.max(0, y + height - e.endCoordinates.screenY);
        animate(e);
        setInset(overlap);
        setTimeout(() => onShownRef.current?.(), 50);
      });
    };
    const onHide = (e: KeyboardEvent) => {
      animate(e);
      setInset(0);
    };

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <View ref={ref} style={[{ flex: 1 }, style, { paddingBottom: inset }]}>
      {children}
    </View>
  );
}
