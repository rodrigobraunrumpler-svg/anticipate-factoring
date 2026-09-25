import type { ReactNode } from 'react'
import { Body, Container, Head, Html, Preview, Section, Text } from 'react-email'

/** Marco común de los correos: idioma, vista previa y pie. */
export function Layout(props: { preview: string; children: ReactNode }) {
  return (
    <Html lang="es">
      <Head />
      <Preview>{props.preview}</Preview>
      <Body
        lang="es"
        style={{ backgroundColor: '#f6f7f9', fontFamily: 'Arial, Helvetica, sans-serif' }}
      >
        <Container style={{ backgroundColor: '#ffffff', padding: '24px', maxWidth: '560px' }}>
          {props.children}
          <Section>
            <Text style={{ color: '#6b7280', fontSize: '12px' }}>
              Anticipate · Este es un correo automático, no respondas a esta dirección.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
