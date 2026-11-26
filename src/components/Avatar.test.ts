import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  InitialsAvatar,
  MausAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type MausAvatarProps,
} from "./Avatar";

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("MausAvatar body", () => {
  it("wears hausmaus when no body or cursor is given", () => {
    expect(render({})).toContain('data-object-body="hausmaus"');
    expect(render({ bodyId: "cursor" })).toContain('data-object-body="hausmaus"');
  });

  it("draws every shape with the Open Bot Avatar engine", () => {
    expect(render({ bodyId: "star" })).toContain('data-object-body="star"');
    expect(render({ bodyId: "circle" })).toContain('data-object-body="circle"');
    expect(render({})).toContain('data-object-body="hausmaus"');
  });

  it("falls back to hausmaus for an unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a MascotBodyId, to exercise the runtime fallback for persisted or streamed
    // data.
    expect(render({ bodyId: "hexagram" as MausAvatarProps["bodyId"] })).toContain(
      'data-object-body="hausmaus"',
    );
  });
});

describe("mascot facial feature colors", () => {
  it.each(["white", "black"] as const)("uses %s for both eyes and mouth on carved bodies", (mascotFaceColor) => {
    const ink = mascotFaceColor === "white" ? "#ffffff" : "#000000";
    for (const mascotBody of ["pumpkin", "vampire"] as const) {
      for (const color of ["green", "chrome"] as const) {
        const markup = renderBot({ color, mascotBody, mascotFaceColor });
        expect(markup).toContain(`fill="${ink}"`);
        expect(markup).toContain(`stroke="${ink}"`);
        expect(markup).not.toContain('visibility="hidden"');
      }
    }
  });

  it("cuts the features out of carved bodies when no colour is set", () => {
    for (const markup of [renderBot({ mascotBody: "ghost" }), renderBot({ mascotBody: "pumpkin" })]) {
      expect(markup).toContain("<mask");
      expect(markup).not.toMatch(/stroke="#(?:ffffff|0d0a10)"/);
    }
  });

  it("does not paint features over an uploaded image", () => {
    const markup = renderBot({ mascotFaceColor: "black", avatarUrl: "/api/attachments/photo.png", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("zooms and positions a custom image inside its crop", () => {
    const markup = renderBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 2,
      avatarFocusX: 0.25,
      avatarFocusY: 0.75,
    });
    expect(markup).toContain("scale(2)");
    expect(markup).toContain("25% 75%");
    expect(markup).toContain("border-radius:50%");
  });

  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("border-radius:0");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the gradient mascot when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-avatar="mascot"');
  });

  it("falls back to the gradient mascot when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-avatar="mascot"');
  });
});

describe("theme hooks on faces", () => {
  it("marks a bot's picture, its gradient, carved and object mascots, and leaves a decorative mascot unmarked", () => {
    expect(renderBot({ avatarUrl: "/api/attachments/a.png", avatarCrop: "circle" })).toMatch(/<span data-avatar="picture" data-avatar-kind="bot"/);
    expect(renderBot({})).toMatch(/<span data-avatar="mascot" data-avatar-kind="bot"/);
    expect(renderBot({ mascotBody: "ghost" })).toMatch(/<span data-avatar="mascot" data-avatar-kind="bot"/);
    expect(renderBot({ mascotBody: "obj-ghost" })).toMatch(/<span data-avatar="mascot" data-avatar-kind="bot"/);
    expect(render({})).not.toContain("data-avatar");
  });

  it("marks the person's picture and their initials", () => {
    expect(renderToStaticMarkup(createElement(InitialsAvatar, { initials: "AL", avatarUrl: "/api/attachments/me.png" }))).toMatch(/<img data-avatar="picture" data-avatar-kind="person"/);
    expect(renderToStaticMarkup(createElement(InitialsAvatar, { initials: "AL" }))).toMatch(/<div data-avatar="initials" data-avatar-kind="person"/);
  });
});

describe("resolveBotAvatarOutcome", () => {
  // imageFailed is set by the <img>'s onError, which renderToStaticMarkup never fires, so the decision is a pure
  // function.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
