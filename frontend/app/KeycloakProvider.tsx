"use client";

import { useEffect, useState } from "react";
import keycloak from "./keycloak";

let initPromise: Promise<boolean> | null = null;

export default function KeycloakProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    if (!initPromise) {
      initPromise = keycloak.init({
        onLoad: "login-required",
      });
    }

    initPromise
      .then((auth) => {
        setAuthenticated(auth);
      })
      .catch((error) => {
        console.error("Keycloak initialization failed:", error);
      });
  }, []);

  if (!authenticated) {
    return <p>Loading...</p>;
  }

  return <>{children}</>;
}